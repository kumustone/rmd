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

// ─────────────────────────────────────────────────────────────────────────
// ⭐ 收藏（`design/0043` §2.2 / §2.8）
//
// 这一层的三个失败形态**全是静默的**（复评 §3 点名）：
//   ① 并发：两次点击各自带一份"我看到的列表"，后端按序落盘、前端却被旧回包盖回去；
//   ② 迟到回包：切根/切文档之后，早先那次收藏操作的回包把**新会话**的整份快照套回来；
//   ③ 目标漂移：上移/下移的 `to` 在**入队时**算，前一个操作改完列表后它就指偏了。
// ⇒ 三条判据都造真的「前一个回包还没到」的窗口（⛔ 不睡真时间，用手控 Promise）。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 收藏的假后端：`favorites_apply` **每次挂起**，由用例自己 resolve。
 * ⚠️ 回包形状按真后端：**整份 `SessionSnapshot`**（`commands/mod.rs::favorites_apply`），
 *    而前端只准取 `favorites` 一个字段——这正是下面第 2 条要判的东西。
 */
function installFavFake() {
  const fake = {
    snap: null,
    ops: [],
    gates: [],
    install: function () {
      global.window.__TAURI__.core.invoke = function (cmd, args) {
        if (cmd === 'get_session') return Promise.resolve(clone(fake.snap));
        if (cmd === 'favorites_apply') {
          fake.ops.push(args.op);
          const d = deferred();
          fake.gates.push(d);
          return d.promise;
        }
        throw new Error('未预料的命令：' + cmd);
      };
    },
    reset: async function (snap) {
      fake.snap = snap;
      await S.refresh();
    },
  };
  return fake;
}

function favSnapshot(over) {
  return snapshot(Object.assign({ favorites: [] }, over || {}));
}

test('收藏_发送是串行的：前一个回包没到，第二个操作不发 IPC', async function () {
  const fake = installFavFake();
  fake.install();
  await fake.reset(favSnapshot({ favorites: ['/rootA'] }));

  const first = S.addFavorite('/rootA/b');
  const second = S.addFavorite('/rootA/c');
  await tick();
  assert.deepStrictEqual(fake.ops, [{ kind: 'add', path: '/rootA/b' }],
    '第二个操作在前一个回包到达前就发了 —— 两次写会各自带一份旧列表');

  fake.gates[0].resolve(clone(favSnapshot({ favorites: ['/rootA', '/rootA/b'] })));
  await first;
  await tick();
  assert.deepStrictEqual(fake.ops.map(function (o) { return o.path; }), ['/rootA/b', '/rootA/c']);

  fake.gates[1].resolve(clone(favSnapshot({ favorites: ['/rootA', '/rootA/b', '/rootA/c'] })));
  await second;
  assert.deepStrictEqual(S.state.favorites, ['/rootA', '/rootA/b', '/rootA/c']);
});

test('收藏_迟到回包只取 favorites：⛔ 不用旧整份快照覆盖新会话', async function () {
  const fake = installFavFake();
  fake.install();
  await fake.reset(favSnapshot({ favorites: ['/rootA'] }));

  const pending = S.addFavorite('/rootA/b');
  await tick();
  assert.strictEqual(fake.ops.length, 1);

  // 这期间会话换了（切根 + 代次 +1，且新会话里收藏是空的）
  fake.snap = snapshot({ generation: 2, roots: ['/rootB'], favorites: [] });
  await S.refresh();
  assert.deepStrictEqual(S.state.favorites, []);

  // 旧回包这时才到，且它带着**旧会话**的整份快照（根还是 /rootA、代次 1）
  fake.gates[0].resolve(clone(favSnapshot({ generation: 1, roots: ['/rootA'], favorites: ['/rootA', '/rootA/b'] })));
  const res = await pending;

  assert.strictEqual(res.applied, false);
  assert.strictEqual(res.reason, 'gen');
  assert.deepStrictEqual(S.state.roots, ['/rootB'], '旧回包把根改回去了');
  assert.strictEqual(S.state.generation, 2, '旧回包把代次改回去了');
  assert.deepStrictEqual(S.state.favorites, [], '旧回包把收藏套回了新会话');
});

test('收藏_上移/下移的目标在队首执行时现算（不在入队时）', async function () {
  const fake = installFavFake();
  fake.install();
  await fake.reset(favSnapshot({ favorites: ['/rootA/x'] }));

  // 先收藏 /rootA/y（还没落盘），紧接着让它上移：
  // ⚠️ 入队那一刻 `/rootA/y` **还不在**列表里 ⇒ 若目标按下标入队时算，这一步会变成 'missing'。
  const add = S.addFavorite('/rootA/y');
  const move = S.moveFavorite('/rootA/y', -1);
  await tick();
  assert.deepStrictEqual(fake.ops, [{ kind: 'add', path: '/rootA/y' }]);

  fake.gates[0].resolve(clone(favSnapshot({ favorites: ['/rootA/x', '/rootA/y'] })));
  await add;
  await tick();
  assert.deepStrictEqual(fake.ops[1], { kind: 'move', path: '/rootA/y', to: 0 },
    '上移的目标下标不是在队首执行时算的');

  fake.gates[1].resolve(clone(favSnapshot({ favorites: ['/rootA/y', '/rootA/x'] })));
  const res = await move;
  assert.strictEqual(res.applied, true);
  assert.deepStrictEqual(S.state.favorites, ['/rootA/y', '/rootA/x']);
});

test('收藏_边界与缺项在本地判无操作，不发 IPC', async function () {
  const fake = installFavFake();
  fake.install();
  await fake.reset(favSnapshot({ favorites: ['/rootA/x', '/rootA/y'] }));

  const up = await S.moveFavorite('/rootA/x', -1);   // 首行上移
  const down = await S.moveFavorite('/rootA/y', 1);  // 末行下移
  const gone = await S.moveFavorite('/rootA/zzz', 1); // 不在表里
  assert.deepStrictEqual([up.reason, down.reason, gone.reason], ['edge', 'edge', 'missing']);
  assert.deepStrictEqual(fake.ops, [], '边界/缺项也发了 IPC');
  assert.deepStrictEqual(S.state.favorites, ['/rootA/x', '/rootA/y']);
});

test('收藏_后端拒绝时抛出且内存一个字节都不改', async function () {
  const fake = installFavFake();
  fake.install();
  await fake.reset(favSnapshot({ favorites: ['/rootA/x'] }));

  const pending = S.addFavorite('/rootA/未授权');
  await tick();
  const err = new Error('未授权');
  err.kind = 'not_authorized';
  fake.gates[0].reject(err);
  await assert.rejects(pending, function (e) { return e.kind === 'not_authorized'; });
  assert.deepStrictEqual(S.state.favorites, ['/rootA/x']);

  // ⚠️ 队列**不因一次失败就断**：下一个操作照常发出
  const next = S.addFavorite('/rootA/y');
  await tick();
  assert.deepStrictEqual(fake.ops[1], { kind: 'add', path: '/rootA/y' });
  fake.gates[1].resolve(clone(favSnapshot({ favorites: ['/rootA/x', '/rootA/y'] })));
  await next;
  assert.deepStrictEqual(S.state.favorites, ['/rootA/x', '/rootA/y']);
});

test('收藏_toggle 的方向也在队首执行时判（两次点击不打架）', async function () {
  const fake = installFavFake();
  fake.install();
  await fake.reset(favSnapshot({ favorites: [] }));

  const t1 = S.toggleFavorite('/rootA/x');   // 现在不在 ⇒ add
  const t2 = S.toggleFavorite('/rootA/x');   // 入队那一刻仍不在；执行时已在 ⇒ remove
  await tick();
  assert.deepStrictEqual(fake.ops, [{ kind: 'add', path: '/rootA/x' }]);

  fake.gates[0].resolve(clone(favSnapshot({ favorites: ['/rootA/x'] })));
  await t1;
  await tick();
  assert.deepStrictEqual(fake.ops[1], { kind: 'remove', path: '/rootA/x' });

  fake.gates[1].resolve(clone(favSnapshot({ favorites: [] })));
  await t2;
  assert.deepStrictEqual(S.state.favorites, []);
});

test('收藏_打开走整份快照提交（这条路上 applySnapshot 是对的）', async function () {
  const fake = installFavFake();
  fake.install();
  await fake.reset(favSnapshot({ favorites: ['/rootA'] }));

  global.window.__TAURI__.core.invoke = function (cmd, args) {
    if (cmd === 'open_favorite') {
      assert.strictEqual(args.path, '/rootA', '前端把路径拼过了 —— 必须原串回传');
      return Promise.resolve(clone(snapshot({
        generation: 9, mode: 'directory', roots: ['/rootA'], favorites: ['/rootA'],
      })));
    }
    throw new Error('未预料的命令：' + cmd);
  };
  const snap = await S.openFavorite('/rootA');
  assert.strictEqual(snap.mode, 'directory');
  assert.strictEqual(S.state.generation, 9);
  assert.deepStrictEqual(S.state.roots, ['/rootA']);
});

// ─────────────────────────────────────────────────────────────────────────
// ⭐ 最近目录的删除 / 清空（`design/0045`，隐私：「最近打开的目录也可以清空，删除」）
//
// 与上面收藏那组**同一个形状**，但多一条这个功能自己的失败形态：
//   ⚠️ 回包里还带着 `roots` / `generation` / `currentDoc`——无条件 `applySnapshot`
//     会把"这期间已经切换的会话"套回旧值；而"只吃 `recent`、忘了 `last_directory`"
//     的表现是**侧边栏「打开上次的目录」仍指向一条已经被删掉的历史**（看着像没删干净）。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 最近目录的假后端：`recent_apply` **每次挂起**，由用例自己 resolve。
 * ⚠️ 回包形状按真后端：**整份 `SessionSnapshot`**（`commands/mod.rs::recent_apply`）。
 */
function installRecentFake() {
  const fake = {
    snap: null,
    ops: [],
    gates: [],
    install: function () {
      global.window.__TAURI__.core.invoke = function (cmd, args) {
        if (cmd === 'get_session') return Promise.resolve(clone(fake.snap));
        if (cmd === 'recent_apply') {
          fake.ops.push(args.op);
          const d = deferred();
          fake.gates.push(d);
          return d.promise;
        }
        throw new Error('未预料的命令：' + cmd);
      };
    },
    reset: async function (snap) {
      fake.snap = snap;
      await S.refresh();
    },
  };
  return fake;
}

/** 一条最近行的形状（后端 `recent_dirs` 的产物；⚠️ 字段名是 **snake_case**）。 */
function recentRow(root, lastFile) {
  return { root: root, last_file: lastFile || null, last: false };
}

function recentSnapshot(over) {
  return snapshot(Object.assign({
    recent: [recentRow('/rootA'), recentRow('/rootA/sub', '/rootA/sub/x.md')],
    last_directory: '/rootA',
  }, over || {}));
}

test('最近_删除串行发送，且路径原串回传（⛔ 不规范化）', async function () {
  const fake = installRecentFake();
  fake.install();
  await fake.reset(recentSnapshot());

  // ⚠️ 尾部分隔符**原样**进去：后端要求逐字命中记录，前端⛔ 不许 `normalize`
  const first = S.removeRecent('/rootA/');
  const second = S.removeRecent('/rootA/sub');
  await tick();
  assert.deepStrictEqual(fake.ops, [{ kind: 'remove', path: '/rootA/' }],
    '第二个操作在前一个回包到达前就发了 —— 两次写会各自带一份旧列表');

  fake.gates[0].resolve(clone(recentSnapshot({
    recent: [recentRow('/rootA/sub', '/rootA/sub/x.md')], last_directory: null,
  })));
  await first;
  await tick();
  assert.deepStrictEqual(fake.ops[1], { kind: 'remove', path: '/rootA/sub' });
  fake.gates[1].resolve(clone(recentSnapshot({ recent: [], last_directory: null })));
  await second;
  assert.deepStrictEqual(S.state.recent, []);
});

test('最近_回包只吃 recent 与 last_directory：⛔ 不用旧整份快照覆盖会话', async function () {
  const fake = installRecentFake();
  fake.install();
  await fake.reset(recentSnapshot());

  const pending = S.clearRecent();
  await tick();
  assert.deepStrictEqual(fake.ops, [{ kind: 'clear' }]);

  // 这期间换了根（代次 +1）
  fake.snap = snapshot({ generation: 2, roots: ['/rootB'], recent: [recentRow('/rootB')] });
  await S.refresh();
  assert.deepStrictEqual(S.state.roots, ['/rootB']);

  // 旧回包这时才到，且它带着**旧会话**的整份快照（根还是 /rootA、代次 1）
  fake.gates[0].resolve(clone(recentSnapshot({ generation: 1, roots: ['/rootA'], recent: [], last_directory: null })));
  const res = await pending;

  assert.strictEqual(res.applied, false);
  assert.strictEqual(res.reason, 'gen');
  assert.deepStrictEqual(S.state.roots, ['/rootB'], '旧回包把根改回去了');
  assert.deepStrictEqual(S.state.recent.map(function (r) { return r.root; }), ['/rootB'],
    '旧回包把最近表套回了新会话');
});

test('最近_成功回包同时更新 last_directory（否则「打开上次的目录」指向已删的历史）', async function () {
  const fake = installRecentFake();
  fake.install();
  await fake.reset(recentSnapshot());
  assert.strictEqual(S.state.lastDirectory, '/rootA', '前置：快照里得有那次"上次打开"');

  const pending = S.removeRecent('/rootA');
  await tick();
  fake.gates[0].resolve(clone(recentSnapshot({
    recent: [recentRow('/rootA/sub', '/rootA/sub/x.md')], last_directory: null,
  })));
  const res = await pending;

  assert.strictEqual(res.applied, true);
  assert.deepStrictEqual(S.state.recent.map(function (r) { return r.root; }), ['/rootA/sub']);
  assert.strictEqual(S.state.lastDirectory, null, 'last_directory 没跟着清 —— 侧边栏会指向一条已删的历史');
});

test('最近_写盘失败时抛出、内存不改，且队列不因此断掉', async function () {
  const fake = installRecentFake();
  fake.install();
  await fake.reset(recentSnapshot());
  const before = clone(S.state.recent);

  const pending = S.clearRecent();
  await tick();
  const err = new Error('磁盘满了');
  err.kind = 'io';
  fake.gates[0].reject(err);
  await assert.rejects(pending, function (e) { return e.kind === 'io'; });
  assert.deepStrictEqual(S.state.recent, before, '失败却改了内存');
  assert.strictEqual(S.state.lastDirectory, '/rootA', '失败却清了 last_directory');

  // ⚠️ 一次失败只断那一环：下一个操作照常发出
  const next = S.removeRecent('/rootA');
  await tick();
  assert.deepStrictEqual(fake.ops[1], { kind: 'remove', path: '/rootA' });
  fake.gates[1].resolve(clone(recentSnapshot({
    recent: [recentRow('/rootA/sub', '/rootA/sub/x.md')], last_directory: null,
  })));
  assert.strictEqual((await next).applied, true);
});
