// 会话真值（`src/services/session.js`）的回归：提交判据、IPC 键名、串行写者。
//
// 从历史缺陷出发，守四族**静默**错误：
//   · `0064` 换文档后旧回包把状态改回去 —— 提交必须用**提交那一刻**的版本；
//   · `0067` 正文被外部改过却不重载 —— 重载多一条 `real_path` 身份判据；
//   · `0088` 三条命令的 IPC 参数键写成 snake_case —— 链接打不开、进度不落盘、
//     目录会话记不住上次文件，三者都没有任何报错；
//   · `0019` / `0043` / `0045` 的写者：收藏与最近目录各自串行，回包只提交自己的字段。
// 另外守 `0056` 关闭文档的身份取 `currentDoc.doc_seq`（⛔ 不是快照里的旧会话号）。
//
// ⚠️ 本文件用**假 tauri**（`call` / `isStale` / `isStaleRevision`）与**假 diskEvents**，
//    `versions` / `search` / `dirSession` 用产品原文件；⛔ 不启动应用、不联网。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadInto(win, rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'module', 'require', src)(win, undefined, undefined);
}

const win = { rmd: {} };
loadInto(win, 'src/services/i18n.js');
loadInto(win, 'src/services/versions.js');
loadInto(win, 'src/services/search.js');
loadInto(win, 'src/services/dirsession.js');

const calls = [];
const handlers = {};
const diskAdopt = [];
let seqValue = 0;

win.rmd.tauri = {
  call: async function (cmd, args) {
    calls.push({ cmd: cmd, args: args });
    const h = handlers[cmd];
    if (typeof h !== 'function') throw new Error('没有假后端：' + cmd);
    return h(args);
  },
  isStale: function (e) { return !!(e && e.kind === 'stale'); },
  isStaleRevision: function (e) { return !!(e && e.kind === 'stale_revision'); },
};
win.rmd.diskEvents = {
  seq: function () { return seqValue; },
  adopt: function (v) { diskAdopt.push(v); return true; },
};

loadInto(win, 'src/services/session.js');
const S = win.rmd.session;
const state = S.state;

function deferred() {
  let resolve, reject;
  const promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
  return { promise: promise, resolve: resolve, reject: reject };
}

function reset(over) {
  Object.assign(state, {
    generation: 1,
    mode: 'directory',
    roots: ['/r'],
    files: [],
    pendingDirectory: null,
    startupDocument: null,
    sidebarWidth: 280,
    lastDirectory: null,
    latestReq: 0,
    latestTreeReq: 0,
    latestSearchReq: 0,
    latestDocListReq: 0,
    sidebarFileView: 'tree',
    hideEmptyDirs: true,
    liveEdit: false,
    fileViewDirty: false,
    committedReq: 0,
    currentDoc: null,
    currentPath: null,
    watchSeq: 0,
    watchPath: null,
    watchStopped: false,
    watchDropped: 0,
    watchNote: '',
    watchNoteKey: '',
    watchNoteArg: '',
    readingProgress: {},
    docSeq: 0,
    recent: [],
    favorites: [],
    dirSession: null,
    dirSessionGen: 0,
    restoredGen: 0,
    treeRestorePending: 0,
    restoreToken: null,
  }, over || {});
  calls.length = 0;
  diskAdopt.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  seqValue = 0;
}

function snapshot(over) {
  return Object.assign({
    generation: 1,
    mode: 'directory',
    roots: ['/r'],
    files: [],
    pending_directory: null,
    startup_document: null,
    sidebar_width: 280,
    sidebar_file_view: 'tree',
    hide_empty_dirs: true,
    live_edit: false,
    last_directory: null,
    recent: [],
    favorites: [],
    reading_progress: {},
    doc_seq: 0,
    dir_session: null,
  }, over || {});
}

function docPayload(args, over) {
  return Object.assign({
    gen: args.generation,
    req: args.req,
    real_path: '/r/a.md',
    roots_nonempty: false,
    outside_roots: false,
  }, over || {});
}

function countCmd(name) {
  return calls.filter(function (c) { return c.cmd === name; }).length;
}

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0064（换文档后旧回包把状态恢复成编辑态）
// 变体：搜索 / 树 / 文档三条提交点都必须在**提交那一刻**复核版本。
// ─────────────────────────────────────────────────────────────────────────

test('0064/空模式搜索不发 IPC，但仍占一个请求号', async () => {
  reset();
  const before = state.latestSearchReq;
  const out = await S.searchFiles('   ', false);
  assert.deepStrictEqual(out, { result: null, decision: { commit: false, reason: 'empty' } });
  assert.strictEqual(countCmd('search_files'), 0);
  assert.strictEqual(state.latestSearchReq, before + 1);
});

test('0064/空模式 + 强制重建必须发 IPC（索引的建立与模式无关）', async () => {
  reset();
  handlers.search_files = function (args) {
    // ⚠️ 请求里**没有** generation（后端按当前根自己填），回包里才有。
    return { req: args.req, generation: 1, entries: [] };
  };
  const out = await S.searchFiles('', true);
  assert.strictEqual(countCmd('search_files'), 1);
  assert.deepStrictEqual(calls[0].args, { pattern: '', req: state.latestSearchReq, rebuild: true });
  assert.strictEqual(out.decision.commit, true);
});

test('0064/正常搜索提交：normalizeResult 后现取 latestSearchReq 比对', async () => {
  reset();
  handlers.search_files = function (args) {
    return { req: args.req, generation: 1, entries: [{ real_path: '/r/新.md' }] };
  };
  const out = await S.searchFiles('新', false);
  assert.strictEqual(out.decision.commit, true);
  assert.strictEqual(out.result.entries[0].realPath, '/r/新.md');
  assert.deepStrictEqual(calls[0].args, { pattern: '新', req: state.latestSearchReq, rebuild: false });
});

test('0064/搜索回包到得晚于下一次输入 ⇒ 请求号不符，整包不提交', async () => {
  reset();
  const d = deferred();
  handlers.search_files = function () { return d.promise; };
  const p = S.searchFiles('旧', false);
  await S.searchFiles('', false); // 删空：占一个更新的请求号
  d.resolve({ req: 1, generation: 1, entries: [{ real_path: '/r/旧.md' }] });
  const out = await p;
  assert.deepStrictEqual(out.decision, { commit: false, reason: 'req' });
  assert.strictEqual(out.result.entries.length, 1, '结果照常归一，但调用方不许提交');
});

test('0064/后端判 stale（遍历期间换根）是正常路径，不抛', async () => {
  reset();
  handlers.search_files = function () { throw { kind: 'stale' }; };
  const out = await S.searchFiles('a', false);
  assert.deepStrictEqual(out, { result: null, decision: { commit: false, reason: 'gen' } });
});

test('0064/搜索的非 stale 失败照常抛给调用方', async () => {
  reset();
  handlers.search_files = function () { throw { kind: 'io', message: '读不了' }; };
  await assert.rejects(function () { return S.searchFiles('a', false); }, function (e) {
    return e.kind === 'io';
  });
});

test('0064/归一失败（缺 req / generation）⇒ shape 不提交', async () => {
  reset();
  handlers.search_files = function () { return { entries: [] }; };
  const out = await S.searchFiles('a', false);
  assert.strictEqual(out.result, null);
  assert.deepStrictEqual(out.decision, { commit: false, reason: 'shape' });
});

test('0064/树：gen 不符放弃，⛔ 不重列', async () => {
  reset();
  seqValue = 1;
  handlers.list_dir = function () { return { gen: 99 }; };
  const out = await S.listDir('/r');
  assert.deepStrictEqual(out.decision, { commit: false, reason: 'gen' });
});

test('0064/树：读盘期间内容修订前进 ⇒ reason=rev（要重列，⛔ 不是放弃）', async () => {
  reset();
  seqValue = 1;
  handlers.list_dir = function () {
    seqValue = 2;
    return { gen: 1 };
  };
  const out = await S.listDir('/r');
  assert.deepStrictEqual(out.decision, { commit: false, reason: 'rev' });
});

test('0064/树：后端 stale_revision 与前端那次比较是同一件事，处置同为 rev', async () => {
  reset();
  handlers.list_dir = function () { throw { kind: 'stale_revision' }; };
  const out = await S.listDir('/r');
  assert.deepStrictEqual(out.decision, { commit: false, reason: 'rev' });
});

test('0064/树：后端 stale（换根）处置为 gen', async () => {
  reset();
  handlers.list_dir = function () { throw { kind: 'stale' }; };
  const out = await S.listDir('/r');
  assert.deepStrictEqual(out.decision, { commit: false, reason: 'gen' });
});

test('0064/树：代次与内容修订都没变才提交', async () => {
  reset();
  seqValue = 4;
  handlers.list_dir = function (args) {
    assert.deepStrictEqual(args, { path: '/r/a', generation: 1, req: state.latestTreeReq, fresh: true });
    return { gen: 1 };
  };
  const out = await S.listDir('/r/a', true);
  assert.deepStrictEqual(out.decision, { commit: true, reason: null });
});

test('0064/树提交判据只有 gen：请求号不参与（父层与子层并发是常态）', async () => {
  reset();
  seqValue = 0;
  handlers.list_dir = function () { return { gen: 1 }; };
  const a = S.listDir('/r');
  const b = S.listDir('/r/a');
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra.decision.commit, true);
  assert.strictEqual(rb.decision.commit, true);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0067（正文在打开后被改过时不自动重载）
// 变体：重载多一条 real_path 身份判据；代次相同不足以说明同一份文档。
// ─────────────────────────────────────────────────────────────────────────

test('0067/重载成功：提交 payload，并更新当前文档与已提交请求号', async () => {
  reset({ currentPath: '/r/a.md' });
  handlers.reload_document = function (args) {
    return docPayload(args, { real_path: '/r/a.md', html: '<p>新正文</p>' });
  };
  const before = state.latestReq;
  const out = await S.reloadDocument();
  assert.strictEqual(out.decision.commit, true);
  assert.strictEqual(out.payload.html, '<p>新正文</p>');
  assert.strictEqual(state.currentDoc, out.payload);
  assert.strictEqual(state.currentPath, '/r/a.md');
  assert.strictEqual(state.committedReq, before + 1);
  assert.deepStrictEqual(calls[0].args, { generation: 1, req: before + 1 });
});

test('0067/代次相同但 real_path 变了 ⇒ identity 不提交，界面不动', async () => {
  reset({ currentPath: '/r/a.md' });
  handlers.reload_document = function (args) {
    return docPayload(args, { real_path: '/r/b.md' });
  };
  const out = await S.reloadDocument();
  assert.deepStrictEqual(out.decision, { commit: false, reason: 'identity' });
  assert.strictEqual(out.payload, null);
  assert.strictEqual(state.currentDoc, null);
  assert.strictEqual(state.currentPath, '/r/a.md');
});

test('0067/重载回包的代次不符 ⇒ gen，⛔ 不写状态', async () => {
  reset({ currentPath: '/r/a.md' });
  handlers.reload_document = function (args) {
    return docPayload(args, { gen: 99 });
  };
  const out = await S.reloadDocument();
  assert.deepStrictEqual(out.decision, { commit: false, reason: 'gen' });
  assert.strictEqual(state.currentDoc, null);
});

test('0067/重载遇到 stale 是正常路径，返回 gen 不抛', async () => {
  reset({ currentPath: '/r/a.md' });
  handlers.reload_document = function () { throw { kind: 'stale' }; };
  const out = await S.reloadDocument();
  assert.deepStrictEqual(out, { payload: null, decision: { commit: false, reason: 'gen' } });
});

test('0067/重载的其他失败照常抛', async () => {
  reset({ currentPath: '/r/a.md' });
  handlers.reload_document = function () { throw { kind: 'io' }; };
  await assert.rejects(function () { return S.reloadDocument(); }, function (e) { return e.kind === 'io'; });
});

test('0067/打开文档：提交用的是后端给的 real_path，⛔ 不是请求里的字符串', async () => {
  reset();
  handlers.open_document = function (args) {
    return docPayload(args, { real_path: '/r/规范化后的.md' });
  };
  const out = await S.openDocument('/r/../r/原样.md');
  assert.strictEqual(out.decision.commit, true);
  assert.strictEqual(state.currentPath, '/r/规范化后的.md');
  assert.deepStrictEqual(calls[0].args, {
    path: '/r/../r/原样.md', generation: 1, req: state.latestReq,
  });
});

test('0067/打开文档：回包代次不符时不进入第③步（⛔ 清掉用户的树）', async () => {
  reset();
  handlers.open_document = function (args) {
    return docPayload(args, { gen: 2, roots_nonempty: true, outside_roots: true });
  };
  const out = await S.openDocument('/r/a.md');
  assert.deepStrictEqual(out.decision, { commit: false, reason: 'gen' });
  assert.strictEqual(countCmd('close_directory'), 0);
  assert.strictEqual(out.closed, undefined);
});

test('0067/打开文档：提交之后才收回旧目录授权（顺序不能换）', async () => {
  reset();
  handlers.open_document = function (args) {
    return docPayload(args, { roots_nonempty: true, outside_roots: true });
  };
  handlers.close_directory = function () {
    return snapshot({ generation: 2, roots: [] });
  };
  const out = await S.openDocument('/r/a.md');
  assert.deepStrictEqual(calls.map(function (c) { return c.cmd; }), ['open_document', 'close_directory']);
  assert.strictEqual(out.closed.generation, 2);
});

test('0067/打开文档：单文件模式（不在旧 root 外）不触发第③步', async () => {
  reset();
  handlers.open_document = function (args) {
    return docPayload(args, { roots_nonempty: true, outside_roots: false });
  };
  const out = await S.openDocument('/r/a.md');
  assert.strictEqual(out.closed, null);
  assert.strictEqual(countCmd('close_directory'), 0);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0056（关闭当前文档：F2 的唯一下场）
// 变体：身份取 currentDoc.doc_seq；监视真值先清；身份不符界面不动。
// ─────────────────────────────────────────────────────────────────────────

test('0056/身份取 currentDoc.doc_seq，⛔ 不是只随快照更新的 state.docSeq', async () => {
  reset({ docSeq: 7, currentDoc: { doc_seq: 42, real_path: '/r/a.md' } });
  handlers.close_document = function () { return snapshot({ doc_seq: 0 }); };
  await S.closeDocument();
  assert.deepStrictEqual(calls[0].args, { docSeq: 42 });
});

test('0056/后端确认归零才认：清当前文档与路径，并套用快照', async () => {
  reset({ currentDoc: { doc_seq: 42, real_path: '/r/a.md' }, currentPath: '/r/a.md' });
  handlers.close_document = function () {
    return snapshot({ mode: 'empty', roots: [], doc_seq: 0, recent: [{ root: '/r' }] });
  };
  const closed = await S.closeDocument();
  assert.strictEqual(closed, true);
  assert.strictEqual(state.currentDoc, null);
  assert.strictEqual(state.currentPath, null);
  assert.strictEqual(state.mode, 'empty');
  assert.deepStrictEqual(state.recent, [{ root: '/r' }]);
});

test('0056/身份不符（回包 doc_seq 非 0）⇒ 界面不动，返回 false', async () => {
  reset({ currentDoc: { doc_seq: 42, real_path: '/r/a.md' }, currentPath: '/r/a.md' });
  handlers.close_document = function () { return snapshot({ doc_seq: 9 }); };
  const closed = await S.closeDocument();
  assert.strictEqual(closed, false);
  assert.strictEqual(state.currentDoc.doc_seq, 42);
  assert.strictEqual(state.currentPath, '/r/a.md');
});

test('0056/发命令前先清本地监视真值（迟到事件被 seq<=0 挡掉）', async () => {
  reset({
    watchSeq: 11, watchPath: '/r/a.md',
    currentDoc: { doc_seq: 42, real_path: '/r/a.md' },
  });
  let seenSeq = null;
  handlers.close_document = function () {
    seenSeq = state.watchSeq;
    return snapshot({ doc_seq: 0 });
  };
  await S.closeDocument();
  assert.strictEqual(seenSeq, 0);
  assert.strictEqual(state.watchPath, null);
});

test('0056/命令失败照样抛，⛔ 不在这里吞掉', async () => {
  reset({ currentDoc: { doc_seq: 42, real_path: '/r/a.md' }, watchSeq: 11 });
  handlers.close_document = function () { throw { kind: 'io' }; };
  await assert.rejects(function () { return S.closeDocument(); }, function (e) { return e.kind === 'io'; });
  assert.strictEqual(state.watchSeq, 0, '抛之前已经清了本地监视真值');
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0088（三条命令的 IPC 参数键写成 snake_case 导致静默失败）
// 变体：所有带参数的封装都用 Tauri 2 的 camelCase 键。
// ─────────────────────────────────────────────────────────────────────────

test('0088/set_reading_progress 用 docSeq，⛔ 不是 doc_seq', async () => {
  reset();
  handlers.set_reading_progress = function () { return { ok: true }; };
  await S.setReadingProgress('/r/a.md', 5, { scrollTop: 12 });
  assert.deepStrictEqual(calls[0].args, { path: '/r/a.md', docSeq: 5, progress: { scrollTop: 12 } });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[0].args, 'doc_seq'), false);
});

test('0088/set_dir_session 用 lastFile，⛔ 不是 last_file', async () => {
  reset();
  handlers.set_dir_session = function () { return { status: 'ok' }; };
  await S.setDirSession('/r', 2, '/r/a.md', ['/r', '/r/sub']);
  assert.deepStrictEqual(calls[0].args, {
    root: '/r', generation: 2, lastFile: '/r/a.md', expanded: ['/r', '/r/sub'],
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[0].args, 'last_file'), false);
});

test('0088/open_link 用 docSeq，链接才不会点了没反应', async () => {
  reset();
  handlers.open_link = function () { return { kind: 'document' }; };
  await S.openLink('b.md#标题', 33);
  assert.deepStrictEqual(calls[0].args, { href: 'b.md#标题', docSeq: 33 });
});

test('0088/close_document 的 docSeq 与开文档身份一致（对照组）', async () => {
  reset({ currentDoc: { doc_seq: 8, real_path: '/r/a.md' } });
  handlers.close_document = function () { return snapshot({ doc_seq: 0 }); };
  await S.closeDocument();
  assert.strictEqual(calls[0].args.docSeq, 8);
});

test('0088/create_entry 原样递用户输入，⛔ 不 trim、⛔ 不补扩展名', async () => {
  reset();
  handlers.create_entry = function () { return { path: '/r/ 新.md', name: ' 新.md', kind: 'file' }; };
  await S.createEntry('/r', ' 新.md', 'file');
  assert.deepStrictEqual(calls[0].args, { parent: '/r', name: ' 新.md', kind: 'file' });
});

test('0088/rename_entry 原样递旧路径与新名字（⛔ 前端拼目标路径）', async () => {
  reset();
  handlers.rename_entry = function () { return { path: '/r/新.md', old_path: '/r/旧.md', current_moved: false }; };
  await S.renameEntry('/r/旧.md', ' 新 名 ');
  assert.deepStrictEqual(calls[0].args, { from: '/r/旧.md', name: ' 新 名 ' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[0].args, 'to'), false);
});

test('0088/add_favorite 与移除都只递 path 原串', async () => {
  reset();
  handlers.favorites_apply = function () { return { favorites: ['/r/x.md '] }; };
  await S.addFavorite('/r/x.md ');
  assert.deepStrictEqual(calls[0].args, { op: { kind: 'add', path: '/r/x.md ' } });
});

test('0088/reveal_entry 原样递路径，⛔ 不 trim、不转义', async () => {
  reset();
  handlers.reveal_entry = function () { return { path: '/r/资料', is_dir: true }; };
  const weird = '/r/带 空格/名字"引号".md ';
  await S.revealEntry(weird);
  assert.deepStrictEqual(calls[0].args, { path: weird });
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
// 变体：侧边栏形态写者；快照只认 snake_case 字段。
// ─────────────────────────────────────────────────────────────────────────

test('0019/形态乐观更新：IPC 未回就已是用户选的那个', async () => {
  reset();
  const d = deferred();
  handlers.set_sidebar_file_view = function () { return d.promise; };
  const p = S.setSidebarFileView('list');
  assert.strictEqual(state.sidebarFileView, 'list');
  d.resolve('list');
  assert.strictEqual(await p, 'list');
});

test('0019/回包说后端实际生效的是另一个 ⇒ 以回包为准', async () => {
  reset();
  handlers.set_sidebar_file_view = function () { return 'tree'; };
  const applied = await S.setSidebarFileView('list');
  assert.strictEqual(applied, 'tree');
  assert.strictEqual(state.sidebarFileView, 'tree');
  assert.deepStrictEqual(calls[0].args, { view: 'list' });
});

test('0019/非 list 的输入一律当 tree（⛔ 不把垃圾值写给后端）', async () => {
  reset({ sidebarFileView: 'list' });
  handlers.set_sidebar_file_view = function () { return 'tree'; };
  await S.setSidebarFileView('grid');
  assert.deepStrictEqual(calls[0].args, { view: 'tree' });
});

test('0019/存盘失败置 fileViewDirty，⛔ 不回滚（后端内存里已经改了）', async () => {
  reset();
  handlers.set_sidebar_file_view = function () { throw { kind: 'io' }; };
  await assert.rejects(function () { return S.setSidebarFileView('list'); });
  assert.strictEqual(state.sidebarFileView, 'list');
  assert.strictEqual(state.fileViewDirty, true);
});

test('0019/快照字段一律 snake_case：形态 / 空目录开关 / 连续性开关', async () => {
  reset();
  handlers.get_session = function () {
    return snapshot({
      sidebar_file_view: 'list',
      hide_empty_dirs: false,
      live_edit: true,
    });
  };
  await S.refresh();
  assert.strictEqual(state.sidebarFileView, 'list');
  assert.strictEqual(state.hideEmptyDirs, false);
  assert.strictEqual(state.liveEdit, true);
});

test('0019/坏值回落安全侧：形态 unknown→tree、开关缺键→true、live_edit 非 true→false', async () => {
  reset();
  handlers.get_session = function () {
    const s = snapshot({ sidebar_file_view: 'grid', live_edit: 'true' });
    delete s.hide_empty_dirs;
    return s;
  };
  await S.refresh();
  assert.strictEqual(state.sidebarFileView, 'tree');
  assert.strictEqual(state.hideEmptyDirs, true);
  assert.strictEqual(state.liveEdit, false);
});

test('0019/快照里的收藏是拷贝，⛔ 不与后端对象共用数组', async () => {
  reset();
  const favs = ['/r/a.md'];
  handlers.get_session = function () { return snapshot({ favorites: favs }); };
  await S.refresh();
  assert.deepStrictEqual(state.favorites, favs);
  assert.notStrictEqual(state.favorites, favs);
});

test('0019/favorites 非数组时清成空数组，⛔ 保留旧值', async () => {
  reset({ favorites: ['/r/old.md'] });
  handlers.get_session = function () { return snapshot({ favorites: '坏值' }); };
  await S.refresh();
  assert.deepStrictEqual(state.favorites, []);
});

test('0019/refresh 返回后端原始快照（startup_document 等 snake_case 才读得到）', async () => {
  reset();
  const raw = snapshot({ startup_document: { path: '/r/a.md' } });
  handlers.get_session = function () { return raw; };
  const out = await S.refresh();
  assert.strictEqual(out, raw);
  assert.deepStrictEqual(out.startup_document, { path: '/r/a.md' });
  assert.strictEqual(out.startupDocument, undefined);
});

test('0019/换代次清掉待补展开记录，同代次保留', async () => {
  reset({ generation: 1, treeRestorePending: 5 });
  handlers.get_session = function () { return snapshot({ generation: 1 }); };
  await S.refresh();
  assert.strictEqual(state.treeRestorePending, 5);
  handlers.get_session = function () { return snapshot({ generation: 2 }); };
  await S.refresh();
  assert.strictEqual(state.treeRestorePending, 0);
});

test('0019/快照镜像 dir_session 与代次成对，restoreToken 一定清空', async () => {
  reset({ restoreToken: { generation: 1 } });
  const ds = { last_file: '/r/a.md', expanded: ['/r'] };
  handlers.get_session = function () { return snapshot({ generation: 3, dir_session: ds }); };
  await S.refresh();
  assert.strictEqual(state.dirSession, ds);
  assert.strictEqual(state.dirSessionGen, 3);
  assert.strictEqual(state.restoreToken, null);
});

test('0019/文档身份只在当前根内算数：前缀陷阱 /rfoo 必须清掉', async () => {
  reset({
    generation: 1, roots: ['/r'],
    currentDoc: { real_path: '/rfoo/a.md', doc_seq: 9 },
    currentPath: '/rfoo/a.md', docSeq: 9,
  });
  handlers.get_session = function () { return snapshot({ generation: 1, roots: ['/r'] }); };
  await S.refresh();
  assert.strictEqual(state.currentDoc, null);
  assert.strictEqual(state.currentPath, null);
  assert.strictEqual(state.docSeq, 0);
});

test('0019/文档路径在根内保留，会话号以快照为准（快照才是 doc_seq 的真值）', async () => {
  reset({
    generation: 1, roots: ['/r'],
    currentDoc: { real_path: '/r/a.md', doc_seq: 9 },
    currentPath: '/r/a.md', docSeq: 9,
  });
  handlers.get_session = function () { return snapshot({ generation: 1 }); };
  await S.refresh();
  assert.strictEqual(state.currentPath, '/r/a.md');
  assert.strictEqual(state.currentDoc.real_path, '/r/a.md');
  assert.strictEqual(state.docSeq, 0, '快照里 doc_seq 是 0 ⇒ 不沿用旧会话号');
});

test('0019/单文件模式（roots 为空）不清当前文档', async () => {
  reset({
    generation: 1, roots: [], currentDoc: { real_path: '/任意/x.md' }, currentPath: '/任意/x.md',
  });
  handlers.get_session = function () { return snapshot({ generation: 1, roots: [] }); };
  await S.refresh();
  assert.strictEqual(state.currentPath, '/任意/x.md');
});

test('0019/快照里的监视健康交给 diskEvents.adopt，⛔ 前端不另存一份', async () => {
  reset();
  const disk = { epoch: 2, revision: 5 };
  handlers.get_session = function () { return snapshot({ disk: disk }); };
  await S.refresh();
  assert.deepStrictEqual(diskAdopt, [disk]);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0043（收藏）：串行、队首现算、只提交 favorites。
// ─────────────────────────────────────────────────────────────────────────

test('0043/收藏写者是串行的：第二次 toggle 在第一次回包之后才决定动作', async () => {
  reset({ favorites: [] });
  handlers.favorites_apply = function (args) {
    return { favorites: args.op.kind === 'add' ? ['/r/a.md'] : [] };
  };
  const p1 = S.toggleFavorite('/r/a.md');
  const p2 = S.toggleFavorite('/r/a.md');
  await Promise.all([p1, p2]);
  assert.deepStrictEqual(calls.map(function (c) { return c.args.op.kind; }), ['add', 'remove']);
});

test('0043/addFavorite / removeFavorite 操作枚举正确', async () => {
  reset();
  handlers.favorites_apply = function () { return { favorites: [] }; };
  await S.addFavorite('/r/a.md');
  await S.removeFavorite('/r/a.md');
  assert.deepStrictEqual(calls[0].args.op, { kind: 'add', path: '/r/a.md' });
  assert.deepStrictEqual(calls[1].args.op, { kind: 'remove', path: '/r/a.md' });
});

test('0043/上移首行 / 下移末行本地就判无操作，不发 IPC', async () => {
  reset({ favorites: ['/r/a.md', '/r/b.md'] });
  const first = await S.moveFavorite('/r/a.md', -1);
  const last = await S.moveFavorite('/r/b.md', 1);
  assert.deepStrictEqual(first, { applied: false, reason: 'edge', favorites: ['/r/a.md', '/r/b.md'] });
  assert.deepStrictEqual(last, { applied: false, reason: 'edge', favorites: ['/r/a.md', '/r/b.md'] });
  assert.strictEqual(countCmd('favorites_apply'), 0);
});

test('0043/上移不存在的项 ⇒ missing，不发 IPC', async () => {
  reset({ favorites: ['/r/a.md'] });
  const out = await S.moveFavorite('/r/没有.md', 1);
  assert.strictEqual(out.reason, 'missing');
  assert.strictEqual(countCmd('favorites_apply'), 0);
});

test('0043/下移的目标下标在队首现算（用最新快照，⛔ 不是入队时那份）', async () => {
  reset({ favorites: ['/r/b.md', '/r/a.md', '/r/c.md'] });
  handlers.favorites_apply = function () { return { favorites: ['/r/a.md', '/r/b.md', '/r/c.md'] }; };
  await S.moveFavorite('/r/a.md', 1);
  assert.deepStrictEqual(calls[0].args.op, { kind: 'move', path: '/r/a.md', to: 2 });
});

test('0043/收藏回包只提交 favorites：⛔ 不把整份快照套回来', async () => {
  reset({ generation: 1, roots: ['/r'], currentPath: '/r/a.md' });
  handlers.favorites_apply = function () {
    return {
      favorites: ['/r/b.md'],
      generation: 99,
      roots: ['/别处'],
      doc_seq: 77,
      current_document: { real_path: '/r/别处.md' },
    };
  };
  await S.addFavorite('/r/b.md');
  assert.deepStrictEqual(state.favorites, ['/r/b.md']);
  assert.strictEqual(state.generation, 1);
  assert.deepStrictEqual(state.roots, ['/r']);
  assert.strictEqual(state.docSeq, 0);
  assert.strictEqual(state.currentPath, '/r/a.md');
});

test('0043/回包代次已变 ⇒ 丢弃这次收藏结果（reason=gen）', async () => {
  reset({ generation: 1, favorites: [] });
  const d = deferred();
  handlers.favorites_apply = function () { return d.promise; };
  const p = S.addFavorite('/r/a.md');
  state.generation = 2;
  d.resolve({ favorites: ['/r/a.md'] });
  const out = await p;
  assert.deepStrictEqual(out, { applied: false, reason: 'gen', favorites: [] });
  assert.deepStrictEqual(state.favorites, []);
});

test('0043/一次失败只断那一环，后面的收藏操作照常执行', async () => {
  reset();
  let n = 0;
  handlers.favorites_apply = function () {
    n += 1;
    if (n === 1) throw { kind: 'io' };
    return { favorites: ['/r/b.md'] };
  };
  const p1 = S.addFavorite('/r/a.md');
  const p2 = S.addFavorite('/r/b.md');
  await assert.rejects(p1, function (e) { return e.kind === 'io'; });
  const ok = await p2;
  assert.strictEqual(ok.applied, true);
  assert.deepStrictEqual(state.favorites, ['/r/b.md']);
});

test('0043/回包缺 favorites 时清空（⛔ 保留旧值造成两份真值）', async () => {
  reset({ favorites: ['/r/old.md'] });
  handlers.favorites_apply = function () { return {}; };
  await S.addFavorite('/r/a.md');
  assert.deepStrictEqual(state.favorites, []);
});

test('0043/isFavorite 只读当前数组', () => {
  reset({ favorites: ['/r/a.md'] });
  assert.strictEqual(S.isFavorite('/r/a.md'), true);
  assert.strictEqual(S.isFavorite('/r/b.md'), false);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0045（最近目录）：独立队列，只提交 recent + last_directory。
// ─────────────────────────────────────────────────────────────────────────

test('0045/removeRecent 原样递后端给的原串（尾随空格不裁）', async () => {
  reset();
  handlers.recent_apply = function () { return snapshot({ recent: [] }); };
  await S.removeRecent('/r/带 空格/ ');
  assert.deepStrictEqual(calls[0].args, { op: { kind: 'remove', path: '/r/带 空格/ ' } });
});

test('0045/clearRecent 只发一个 clear 枚举', async () => {
  reset();
  handlers.recent_apply = function () { return snapshot({ recent: [], last_directory: null }); };
  await S.clearRecent();
  assert.deepStrictEqual(calls[0].args, { op: { kind: 'clear' } });
});

test('0045/回包只提交 recent 与 last_directory，⛔ 不动其余会话字段', async () => {
  reset({ generation: 1, roots: ['/r'], currentPath: '/r/a.md', docSeq: 3 });
  handlers.recent_apply = function () {
    return {
      recent: [{ root: '/r' }],
      last_directory: '/r',
      generation: 99,
      roots: ['/别处'],
      doc_seq: 77,
      favorites: ['/r/不该改.md'],
    };
  };
  await S.removeRecent('/x');
  assert.deepStrictEqual(state.recent, [{ root: '/r' }]);
  assert.strictEqual(state.lastDirectory, '/r');
  assert.strictEqual(state.generation, 1);
  assert.deepStrictEqual(state.roots, ['/r']);
  assert.strictEqual(state.docSeq, 3);
  assert.deepStrictEqual(state.favorites, []);
});

test('0045/回包代次已变 ⇒ 丢弃（reason=gen），recent 不动', async () => {
  reset({ generation: 1, recent: [{ root: '/r/old' }] });
  const d = deferred();
  handlers.recent_apply = function () { return d.promise; };
  const p = S.clearRecent();
  state.generation = 2;
  d.resolve({ recent: [], last_directory: null });
  const out = await p;
  assert.deepStrictEqual(out, { applied: false, reason: 'gen' });
  assert.deepStrictEqual(state.recent, [{ root: '/r/old' }]);
});

test('0045/last_directory 缺省时清成 null（侧边栏那句提示不再指向已删历史）', async () => {
  reset({ lastDirectory: '/r/old' });
  handlers.recent_apply = function () { return { recent: [] }; };
  await S.clearRecent();
  assert.strictEqual(state.lastDirectory, null);
});

test('0045/最近目录的失败不影响随后的清空（队列不断）', async () => {
  reset();
  let n = 0;
  handlers.recent_apply = function () {
    n += 1;
    if (n === 1) throw { kind: 'persist_failed' };
    return { recent: [], last_directory: null };
  };
  const p1 = S.removeRecent('/r/a');
  const p2 = S.clearRecent();
  await assert.rejects(p1);
  const ok = await p2;
  assert.strictEqual(ok.applied, true);
});

// ─────────────────────────────────────────────────────────────────────────
// 文件监视（design/0006）：三种失败必须区分且都能被用户看见。
// ─────────────────────────────────────────────────────────────────────────

test('0006/watchDocument 成功：记下 seq / 路径，清掉旧提示', async () => {
  reset({ watchNote: '旧提示', watchNoteKey: 'old' });
  handlers.watch_document = function (args) {
    assert.deepStrictEqual(args, { path: '/r/a.md' });
    return { seq: 12, path: '/r/a.md' };
  };
  const info = await S.watchDocument('/r/a.md');
  assert.deepStrictEqual(info, { seq: 12, path: '/r/a.md' });
  assert.strictEqual(state.watchSeq, 12);
  assert.strictEqual(state.watchPath, '/r/a.md');
  assert.strictEqual(state.watchStopped, false);
  assert.strictEqual(state.watchNote, '');
  assert.strictEqual(state.watchNoteKey, '');
});

test('0006/watchDocument 失败不致命，但必须留下可翻的提示', async () => {
  reset();
  handlers.watch_document = function () { throw { message: '不允许监视' }; };
  const info = await S.watchDocument('/r/a.md');
  assert.strictEqual(info, null);
  assert.strictEqual(state.watchSeq, 0);
  assert.strictEqual(state.watchPath, null);
  assert.strictEqual(state.watchNoteKey, 'reload.watch-start-failed');
  assert.strictEqual(state.watchNoteArg, '不允许监视');
  assert.ok(state.watchNote.indexOf('不允许监视') >= 0);
});

test('0006/授权代次变了 ⇒ 监视真值作废并让后端放下旧 seq', async () => {
  reset({ generation: 1, watchSeq: 11, watchPath: '/r/a.md', watchStopped: false });
  handlers.unwatch_document = function () { return null; };
  handlers.get_session = function () { return snapshot({ generation: 2 }); };
  await S.refresh();
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(state.watchSeq, 0);
  assert.strictEqual(state.watchPath, null);
  assert.strictEqual(state.watchStopped, true);
  assert.strictEqual(state.watchNoteKey, 'reload.watch-stopped');
  const un = calls.filter(function (c) { return c.cmd === 'unwatch_document'; });
  assert.deepStrictEqual(un[0].args, { seq: 11 });
});

test('0006/代次没变时不动监视真值', async () => {
  reset({ generation: 1, watchSeq: 11, watchPath: '/r/a.md' });
  handlers.get_session = function () { return snapshot({ generation: 1 }); };
  await S.refresh();
  assert.strictEqual(state.watchSeq, 11);
  assert.strictEqual(state.watchPath, '/r/a.md');
  assert.strictEqual(countCmd('unwatch_document'), 0);
});

test('0006/unwatchDocument 不带 seq 时不发 IPC；失败只记 stderr 不抛', async () => {
  reset();
  await S.unwatchDocument(0);
  assert.strictEqual(countCmd('unwatch_document'), 0);
  handlers.unwatch_document = function () { throw { kind: 'io' }; };
  await assert.doesNotReject(function () { return S.unwatchDocument(5); });
  assert.deepStrictEqual(calls[0].args, { seq: 5 });
});

test('0006/被丢掉的事件要计数（⛔ 静默丢弃）', () => {
  reset({ watchDropped: 0 });
  S.noteDroppedEvent();
  S.noteDroppedEvent();
  assert.strictEqual(state.watchDropped, 2);
});

// ─────────────────────────────────────────────────────────────────────────
// 其余薄封装：读命令不改会话状态；参数原样递。
// ─────────────────────────────────────────────────────────────────────────

test('readAsset 用文档那一个请求号（图片是正文的一部分）', async () => {
  reset({ generation: 3, latestReq: 17 });
  handlers.read_asset = function () { return { bytes: [] }; };
  await S.readAsset('img/a.png');
  assert.deepStrictEqual(calls[0].args, { src: 'img/a.png', generation: 3, req: 17 });
});

test('takePendingOpen 不是数组时返回空数组', async () => {
  reset();
  handlers.take_pending_open = function () { return null; };
  assert.deepStrictEqual(await S.takePendingOpen(), []);
  handlers.take_pending_open = function () { return ['/r/a.md', 7]; };
  assert.deepStrictEqual(await S.takePendingOpen(), ['/r/a.md', 7]);
});

test('openRecentDirectory 原样递 root，并整份套用快照', async () => {
  reset();
  handlers.open_recent_directory = function (args) {
    assert.deepStrictEqual(args, { root: '/r/记录里的原串' });
    return snapshot({ generation: 4, mode: 'directory', roots: ['/r/记录里的原串'] });
  };
  await S.openRecentDirectory('/r/记录里的原串');
  assert.strictEqual(state.generation, 4);
  assert.deepStrictEqual(state.roots, ['/r/记录里的原串']);
});

test('openFavorite 原样递记录串（INV-FAV-03 要逐字命中）', async () => {
  reset();
  handlers.open_favorite = function (args) {
    assert.deepStrictEqual(args, { path: '/r/a.md ' });
    return snapshot({ generation: 5 });
  };
  await S.openFavorite('/r/a.md ');
  assert.strictEqual(state.generation, 5);
});

test('document 列表：请求号逐次前进，重建标志归一成布尔', async () => {
  reset();
  handlers.list_documents = function (args) { return { gen: args.generation, entries: [] }; };
  const a = await S.listDocuments();
  const b = await S.listDocuments(1);
  assert.strictEqual(a.req + 1, b.req);
  assert.deepStrictEqual(calls[0].args, { generation: 1, req: a.req, rebuild: false });
  assert.deepStrictEqual(calls[1].args, { generation: 1, req: b.req, rebuild: true });
});

test('document 列表：stale 是正常路径（切根后的在途请求）', async () => {
  reset();
  handlers.list_documents = function () { throw { kind: 'stale' }; };
  const out = await S.listDocuments(true);
  assert.strictEqual(out.result, null);
  assert.strictEqual(out.stale, true);
  assert.strictEqual(typeof out.req, 'number');
});

test('currentDocList / current 都在调用那一刻现取', async () => {
  reset({ generation: 2, latestDocListReq: 8, latestReq: 3 });
  assert.deepStrictEqual(S.currentDocList(), { generation: 2, latestDocListReq: 8 });
  assert.deepStrictEqual(S.current(), { generation: 2, latestReq: 3 });
});
