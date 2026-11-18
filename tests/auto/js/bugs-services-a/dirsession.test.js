// 目录会话回归：`src/services/dirsession.js` 的纯函数、恢复事务与写者。
//
// 从历史缺陷出发，守三族**静默**错误：
//   · `0019` 外部新增文件在树里不出现 —— 恢复/写盘把展开集写错，用户看到的是旧树；
//   · `0064` 换文档后旧回包改状态 —— 迟到的 A 响应倒灌进 B（三重回填闸）；
//   · `0067` 恢复失败把“上次的文件”擦成 null —— 下一次树操作就永久落盘成“没有上次”。
// 这些都不报错，只会让“上次的展开态 / 上次的文件”凭空消失。
//
// ⚠️ 模块挂在 `window.rmd.dirSession`（大写 S）。
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

const win = {};
loadInto(win, 'src/services/dirsession.js');
const D = win.rmd.dirSession;

function mkState(over) {
  return Object.assign({
    generation: 1,
    mode: 'directory',
    roots: ['/r'],
    currentPath: null,
    dirSession: null,
    dirSessionGen: 0,
    restoredGen: 0,
    treeRestorePending: 0,
    sidebarFileView: 'tree',
    restoreToken: null,
  }, over || {});
}

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0019 / 0217（路径包含关系是安全判据）
// 变体：前缀陷阱、尾斜杠、中文路径、大小写、软链式并列目录。
// ─────────────────────────────────────────────────────────────────────────

test('0019/相等、父子、尾斜杠都算在里面', () => {
  assert.strictEqual(D.isInside('/a', '/a'), true);
  assert.strictEqual(D.isInside('/a', '/a/b'), true);
  assert.strictEqual(D.isInside('/a/', '/a/b'), true);
  assert.strictEqual(D.isInside('/', '/a'), true);
  assert.strictEqual(D.isInside('/a/b', '/a/b/c/d'), true);
});

test('0019/前缀相同但没有分隔符不算在根里（rootfoo 陷阱）', () => {
  for (const [root, p] of [['/a', '/ab'], ['/a', '/a-b'], ['/a/b', '/a/bc'], ['/r/link', '/r/link2']]) {
    assert.strictEqual(D.isInside(root, p), false, `${root} vs ${p}`);
  }
});

test('0217/软链名字不同但字面前缀相同的路径不会被误判为同一条', () => {
  // ensure_root 的修复方向是“每次刷新链接”；前端这一侧必须按原串包含关系判，
  // ⛔ 不能把 /work/link 与 /work/link-old 当成一条。
  assert.strictEqual(D.isInside('/work/link', '/work/link/a.md'), true);
  assert.strictEqual(D.isInside('/work/link', '/work/link-old/a.md'), false);
  assert.strictEqual(D.isInside('/work/link', '/work/link-old'), false);
});

test('0019/中文路径按字符串包含关系判断', () => {
  assert.strictEqual(D.isInside('/资料', '/资料/笔记/a.md'), true);
  assert.strictEqual(D.isInside('/资料', '/资料库/a.md'), false);
  assert.strictEqual(D.isInside('/资料/笔记', '/资料/笔记.md'), false);
});

test('0019/空值一律为假，⛔ 不把空串当根', () => {
  for (const [a, b] of [['', '/a'], ['/a', ''], [null, '/a'], ['/a', null], [undefined, undefined]]) {
    assert.strictEqual(D.isInside(a, b), false);
  }
});

test('0019/路径比较区分大小写（macOS 文件系统大小写不敏感，但 IPC 串是原样）', () => {
  assert.strictEqual(D.isInside('/r/Notes', '/r/Notes/a.md'), true);
  assert.strictEqual(D.isInside('/r/Notes', '/r/notes/a.md'), false);
});

test('0019/docInRoot：只有目录模式、当前文档在根下且不等于根才算', () => {
  assert.strictEqual(D.docInRoot({ mode: 'directory', currentPath: '/r/a.md' }, '/r'), true);
  assert.strictEqual(D.docInRoot({ mode: 'single', currentPath: '/r/a.md' }, '/r'), false);
  assert.strictEqual(D.docInRoot({ mode: 'directory', currentPath: '/r' }, '/r'), false);
  assert.strictEqual(D.docInRoot({ mode: 'directory', currentPath: '' }, '/r'), false);
  assert.strictEqual(D.docInRoot({ mode: 'directory', currentPath: '/other/a.md' }, '/r'), false);
  assert.strictEqual(D.docInRoot(null, '/r'), false);
});

// ─────────────────────────────────────────────────────────────────────────
// toEntry：前端状态 → IPC 载荷
// ─────────────────────────────────────────────────────────────────────────

test('toEntry：Set 与数组两种 expanded 形态结果一致', () => {
  const a = D.toEntry('/r', '/r/a.md', new Set(['/r/x', '/r/y']));
  const b = D.toEntry('/r', '/r/a.md', ['/r/x', '/r/y']);
  assert.deepStrictEqual(a, b);
});

test('toEntry：丢掉根自身、越界路径、空串与非字符串，并记账', () => {
  const r = D.toEntry('/r', '/r/a.md', ['/r', '/r/x', '/other/y', '', null, 7]);
  assert.deepStrictEqual(r.entry.expanded, ['/r/x']);
  assert.deepStrictEqual(r.dropped, ['/r', '/other/y', '', 'null', '7']);
});

test('toEntry：重复路径静默去重，不记进 dropped', () => {
  const r = D.toEntry('/r', null, ['/r/a', '/r/a', '/r/a']);
  assert.deepStrictEqual(r.entry.expanded, ['/r/a']);
  assert.deepStrictEqual(r.dropped, []);
});

test('toEntry：浅的、字面序小的排在前面（恢复时祖先先于后代）', () => {
  const r = D.toEntry('/r', null, ['/r/b/c', '/r/a', '/r/b', '/r/中', '/r/啊']);
  assert.deepStrictEqual(r.entry.expanded, ['/r/a', '/r/b', '/r/中', '/r/啊', '/r/b/c']);
});

test('toEntry：超过 200 条时截断，溢出的记进 dropped', () => {
  const many = [];
  for (let i = 0; i < 201; i++) many.push('/r/d' + String(i).padStart(3, '0'));
  const r = D.toEntry('/r', null, many);
  assert.strictEqual(r.entry.expanded.length, D.MAX_EXPANDED_PER_DIR);
  assert.strictEqual(r.dropped.length, 1);
  assert.strictEqual(r.dropped[0], '/r/d200');
});

test('toEntry：单条路径按码点数护栏，4096 个汉字放行、4097 个丢掉', () => {
  const ok = '/r/' + '中'.repeat(D.MAX_SESSION_PATH_CHARS - 3);
  const too = '/r/' + '中'.repeat(D.MAX_SESSION_PATH_CHARS - 2);
  assert.strictEqual(D.toEntry('/r', null, [ok]).dropped.length, 0);
  assert.strictEqual(D.toEntry('/r', null, [too]).dropped.length, 1);
});

test('toEntry：last_file 在根下才保留，否则置 null 并记账', () => {
  const inside = D.toEntry('/r', '/r/笔记/a.md', []);
  assert.strictEqual(inside.entry.last_file, '/r/笔记/a.md');
  const outside = D.toEntry('/r', '/other/a.md', []);
  assert.strictEqual(outside.entry.last_file, null);
  assert.deepStrictEqual(outside.dropped, ['/other/a.md']);
  const rootItself = D.toEntry('/r', '/r', []);
  assert.strictEqual(rootItself.entry.last_file, null);
  assert.deepStrictEqual(rootItself.dropped, ['/r']);
});

test('toEntry：last_file 为空 / 非字符串时不记账，直接 null', () => {
  assert.strictEqual(D.toEntry('/r', '', []).entry.last_file, null);
  assert.strictEqual(D.toEntry('/r', null, []).entry.last_file, null);
  assert.strictEqual(D.toEntry('/r', 7, []).entry.last_file, null);
  assert.deepStrictEqual(D.toEntry('/r', '', []).dropped, []);
});

test('toEntry：expanded 不是 Set / 数组时按空处理，不抛', () => {
  assert.deepStrictEqual(D.toEntry('/r', null, null).entry.expanded, []);
  assert.deepStrictEqual(D.toEntry('/r', null, 'nope').entry.expanded, []);
});

test('toEntry：updated_at 先置 0（真值由后端回包给）', () => {
  assert.strictEqual(D.toEntry('/r', null, []).entry.updated_at, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// restorePlan / sameEntry / shouldRestore
// ─────────────────────────────────────────────────────────────────────────

test('restorePlan：从镜像算出由浅到深的展开顺序与上次文件', () => {
  const p = D.restorePlan({
    expanded: ['/r/b/c', '/r/a', '/r/b', '/other/x', '/r'],
    last_file: '/r/b/c/doc.md',
  }, '/r');
  assert.deepStrictEqual(p.dirs, ['/r/a', '/r/b', '/r/b/c']);
  assert.strictEqual(p.file, '/r/b/c/doc.md');
});

test('restorePlan：去重、丢弃越界与超长路径', () => {
  const long = '/r/' + 'x'.repeat(D.MAX_SESSION_PATH_CHARS);
  const p = D.restorePlan({
    expanded: ['/r/a', '/r/a', '/other', '', null, long],
    last_file: '/other/x.md',
  }, '/r');
  assert.deepStrictEqual(p.dirs, ['/r/a']);
  assert.strictEqual(p.file, null);
});

test('restorePlan：镜像缺失 / 根缺失 / expanded 非数组都返回空计划', () => {
  assert.deepStrictEqual(D.restorePlan(null, '/r'), { dirs: [], file: null });
  assert.deepStrictEqual(D.restorePlan({ expanded: ['/r/a'] }, ''), { dirs: [], file: null });
  assert.deepStrictEqual(D.restorePlan({ expanded: 'bad' }, '/r'), { dirs: [], file: null });
});

test('restorePlan：超过 200 条时只取前 200 条（浅的优先）', () => {
  const many = [];
  for (let i = 200; i >= 0; i--) many.push('/r/x' + String(i).padStart(3, '0'));
  const p = D.restorePlan({ expanded: many, last_file: null }, '/r');
  assert.strictEqual(p.dirs.length, 200);
  assert.strictEqual(p.dirs[0], '/r/x000');
  assert.strictEqual(p.dirs[199], '/r/x199');
});

test('sameEntry：两份都空 ⇒ 相同；只有一份 ⇒ 不同', () => {
  assert.strictEqual(D.sameEntry(null, null), true);
  assert.strictEqual(D.sameEntry(null, { last_file: null, expanded: [] }), false);
  assert.strictEqual(D.sameEntry({ last_file: null, expanded: [] }, null), false);
});

test('sameEntry：忽略 updated_at 与数组顺序', () => {
  assert.strictEqual(D.sameEntry(
    { last_file: '/r/a.md', expanded: ['/r/x', '/r/y'], updated_at: 1 },
    { last_file: '/r/a.md', expanded: ['/r/y', '/r/x'], updated_at: 999 }
  ), true);
});

test('sameEntry：last_file 与集合内容任何一处不同即不同', () => {
  const base = { last_file: '/r/a.md', expanded: ['/r/x'] };
  assert.strictEqual(D.sameEntry(base, { last_file: '/r/b.md', expanded: ['/r/x'] }), false);
  assert.strictEqual(D.sameEntry(base, { last_file: '/r/a.md', expanded: ['/r/y'] }), false);
  assert.strictEqual(D.sameEntry(base, { last_file: '/r/a.md', expanded: ['/r/x', '/r/y'] }), false);
});

test('sameEntry：null 与 undefined 的 last_file 视为同一个“没有”', () => {
  assert.strictEqual(D.sameEntry(
    { last_file: null, expanded: [] },
    { last_file: undefined, expanded: [] }
  ), true);
});

test('sameEntry：expanded 非数组按空集合比较', () => {
  assert.strictEqual(D.sameEntry({ last_file: null, expanded: 'x' }, { last_file: null, expanded: [] }), true);
});

test('shouldRestore：目录模式、有镜像、这一代还没恢复过才需要恢复', () => {
  const ok = mkState({ dirSession: { expanded: [], last_file: null }, restoredGen: 0, generation: 3 });
  assert.strictEqual(D.shouldRestore(ok), true);
  assert.strictEqual(D.shouldRestore(mkState({
    dirSession: { expanded: [] }, restoredGen: 3, generation: 3,
  })), false);
  assert.strictEqual(D.shouldRestore(mkState({ dirSession: null })), false);
  assert.strictEqual(D.shouldRestore(mkState({ dirSession: { expanded: [] }, mode: 'single' })), false);
  assert.strictEqual(D.shouldRestore(null), false);
});

// ─────────────────────────────────────────────────────────────────────────
// createRestorer：恢复事务（含取消与失败分支）
// ─────────────────────────────────────────────────────────────────────────

function restorerFixture(over) {
  const st = mkState(over);
  const opened = [];
  const expandedCalls = [];
  const done = [];
  let restoreImpl = async function (dirs) {
    return { restored: dirs.length, skipped: 0, cancelled: false };
  };
  const tree = {
    restoreExpanded: function (dirs, cont) {
      expandedCalls.push({ dirs: dirs.slice(), cont: cont });
      return restoreImpl(dirs, cont);
    },
  };
  const r = D.createRestorer({
    getState: function () { return st; },
    tree: tree,
    openDocument: async function (p, opts) { opened.push({ p: p, opts: opts }); },
    onDone: function (out) { done.push(out); },
  });
  return {
    st: st, r: r, opened: opened, expandedCalls: expandedCalls, done: done,
    setRestoreImpl: function (fn) { restoreImpl = fn; },
  };
}

test('0064/恢复：不满足条件时 idle，不建令牌也不展开', async () => {
  const f = restorerFixture({ dirSession: null });
  const out = await f.r.run();
  assert.deepStrictEqual(out, { restored: 0, skipped: 0, cancelled: false, opened: false, idle: true });
  assert.strictEqual(f.st.restoreToken, null);
  assert.strictEqual(f.st.restoredGen, 0);
  assert.strictEqual(f.expandedCalls.length, 0);
});

test('0064/恢复：祖先先于后代展开，并打开上次的文件', async () => {
  const f = restorerFixture({
    dirSession: { expanded: ['/r/b/c', '/r/a', '/r/b'], last_file: '/r/b/c/doc.md' },
  });
  const out = await f.r.run();
  assert.deepStrictEqual(f.expandedCalls[0].dirs, ['/r/a', '/r/b', '/r/b/c']);
  assert.deepStrictEqual(f.opened.map((o) => o.p), ['/r/b/c/doc.md']);
  assert.strictEqual(f.opened[0].opts.reason, 'restore');
  assert.strictEqual(out.opened, true);
  assert.strictEqual(out.idle, false);
  assert.strictEqual(f.st.restoredGen, 1, '这一代被标记为已恢复');
  assert.strictEqual(f.st.restoreToken, null, '结束后必须清令牌');
  assert.strictEqual(f.done.length, 1);
});

test('0064/恢复：当前文档已经在根下时不再重复打开', async () => {
  const f = restorerFixture({
    currentPath: '/r/b/c/doc.md',
    dirSession: { expanded: ['/r/a'], last_file: '/r/b/c/doc.md' },
  });
  const out = await f.r.run();
  assert.strictEqual(out.opened, false);
  assert.strictEqual(f.opened.length, 0);
});

test('0064/恢复：用户亲手折叠/展开后只补展开，不再自动打开文件', async () => {
  const f = restorerFixture({
    dirSession: { expanded: ['/r/a'], last_file: '/r/a/doc.md' },
  });
  f.setRestoreImpl(async function (dirs) {
    f.r.noteUserToggle();
    return { restored: dirs.length, skipped: 0, cancelled: false };
  });
  const out = await f.r.run();
  assert.strictEqual(out.opened, false);
  assert.strictEqual(f.opened.length, 0);
});

test('0064/恢复：展开期间切根 ⇒ 令牌失效，不打开旧根的文件', async () => {
  const f = restorerFixture({
    dirSession: { expanded: ['/r/a'], last_file: '/r/a/doc.md' },
  });
  f.setRestoreImpl(async function (dirs) {
    f.st.generation += 1;
    return { restored: dirs.length, skipped: 0, cancelled: false };
  });
  const out = await f.r.run();
  assert.strictEqual(out.cancelled, true);
  assert.strictEqual(out.opened, false);
  assert.strictEqual(f.opened.length, 0);
});

test('0064/恢复：cancel() 之后迟到回包不许继续，也不许打开文件', async () => {
  const f = restorerFixture({
    dirSession: { expanded: ['/r/a'], last_file: '/r/a/doc.md' },
  });
  let release;
  f.setRestoreImpl(function () {
    return new Promise(function (resolve) {
      release = function () { resolve({ restored: 1, skipped: 0, cancelled: false }); };
    });
  });
  const p = f.r.run();
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(f.r.isActive(), true);
  assert.strictEqual(f.r.cancel('切换根'), true);
  assert.strictEqual(f.r.isActive(), false);
  release();
  const out = await p;
  assert.strictEqual(out.cancelled, true);
  assert.strictEqual(f.opened.length, 0);
  assert.strictEqual(f.st.restoreToken, null);
});

test('0064/恢复：打开文件抛错不带走整棵侧边栏，结果仍然收尾', async () => {
  const f = restorerFixture({
    dirSession: { expanded: ['/r/a'], last_file: '/r/a/doc.md' },
  });
  const r = D.createRestorer({
    getState: function () { return f.st; },
    tree: { restoreExpanded: async function (dirs) { return { restored: dirs.length, skipped: 0, cancelled: false }; } },
    openDocument: async function () { throw new Error('读盘失败'); },
  });
  const out = await r.run();
  assert.strictEqual(out.opened, true);
  assert.strictEqual(f.st.restoreToken, null);
});

test('0019/列表形态不消费展开记录，只记下“这一代还欠一条”', async () => {
  const f = restorerFixture({
    sidebarFileView: 'list',
    dirSession: { expanded: ['/r/a', '/r/b'], last_file: null },
  });
  const out = await f.r.run();
  assert.strictEqual(f.expandedCalls.length, 0, '用户看不见树时不该逐层展开');
  assert.strictEqual(f.st.treeRestorePending, f.st.generation);
  assert.strictEqual(out.idle, false);
});

test('0019/列表形态且没有展开记录时不欠任何东西', async () => {
  const f = restorerFixture({
    sidebarFileView: 'list',
    dirSession: { expanded: [], last_file: null },
  });
  await f.r.run();
  assert.strictEqual(f.st.treeRestorePending, 0);
});

test('0019/切回树形态时补做一次展开，然后清标记，且不再打开文件', async () => {
  const f = restorerFixture({
    treeRestorePending: 1,
    dirSession: { expanded: ['/r/b', '/r/a'], last_file: '/r/a/doc.md' },
  });
  const out = await f.r.restorePendingTree();
  assert.strictEqual(out.idle, false);
  assert.deepStrictEqual(f.expandedCalls[0].dirs, ['/r/a', '/r/b']);
  assert.strictEqual(f.st.treeRestorePending, 0);
  assert.strictEqual(f.opened.length, 0, '文件在列表形态里已经恢复过');
});

test('0019/还在列表形态时补做展开保持 idle，标记原样留着', async () => {
  const f = restorerFixture({
    sidebarFileView: 'list',
    treeRestorePending: 1,
    dirSession: { expanded: ['/r/a'], last_file: null },
  });
  const out = await f.r.restorePendingTree();
  assert.strictEqual(out.idle, true);
  assert.strictEqual(f.st.treeRestorePending, 1);
  assert.strictEqual(f.expandedCalls.length, 0);
});

test('0019/补做展开只对“这一代”有效：过期标记不清也不做', async () => {
  const f = restorerFixture({
    generation: 2,
    treeRestorePending: 1,
    dirSession: { expanded: ['/r/a'], last_file: null },
  });
  const out = await f.r.restorePendingTree();
  assert.strictEqual(out.idle, true);
  assert.strictEqual(f.st.treeRestorePending, 1);
});

test('0019/补做展开在多根 / 非目录模式下不猜根', async () => {
  const many = restorerFixture({ roots: ['/a', '/b'], treeRestorePending: 1, dirSession: { expanded: ['/a/x'] } });
  assert.strictEqual((await many.r.restorePendingTree()).idle, true);
  const single = restorerFixture({ mode: 'single', treeRestorePending: 1, dirSession: { expanded: ['/r/x'] } });
  assert.strictEqual((await single.r.restorePendingTree()).idle, true);
});

// ─────────────────────────────────────────────────────────────────────────
// createWriter：脏标记、恢复期挂起、三重回填闸
// ─────────────────────────────────────────────────────────────────────────

function writerFixture(over) {
  const st = mkState(over);
  const calls = [];
  const timers = { queue: [], cleared: 0 };
  const treeExpanded = ['/r/a', '/r/b'];
  let response = { status: 'ok', entry: { last_file: null, expanded: [], updated_at: 1 } };
  let impl = null;
  const tree = { expandedPaths: function () { return treeExpanded.slice(); } };
  const w = D.createWriter({
    getState: function () { return st; },
    tree: tree,
    setDirSession: function (root, gen, lastFile, expanded) {
      calls.push({ root: root, gen: gen, lastFile: lastFile, expanded: expanded.slice() });
      if (impl) return impl(root, gen, lastFile, expanded);
      return Promise.resolve(response);
    },
    setTimeout: function (fn, ms) { timers.queue.push({ fn: fn, ms: ms }); return timers.queue.length; },
    clearTimeout: function () { timers.cleared++; },
  });
  return {
    st: st, w: w, calls: calls, timers: timers, treeExpanded: treeExpanded,
    setResponse: function (r) { response = r; },
    setImpl: function (fn) { impl = fn; },
    fireTimer: function () { const q = timers.queue.splice(0); for (const t of q) t.fn(); },
  };
}

test('0064/写者：没有改动时 flush 是 clean，不发 IPC', async () => {
  const f = writerFixture();
  assert.deepStrictEqual(await f.w.flush(), { status: 'clean' });
  assert.strictEqual(f.calls.length, 0);
});

test('0019/写者：树变化去抖 500 ms，连续多次只排一次', async () => {
  const f = writerFixture();
  f.w.noteTreeChange();
  f.w.noteTreeChange();
  f.w.noteTreeChange();
  assert.strictEqual(f.w.isDirty(), true);
  assert.strictEqual(f.timers.queue.length, 1);
  assert.strictEqual(f.timers.queue[0].ms, D.DIR_SESSION_DEBOUNCE_MS);
});

test('0019/写者：去抖到点后写出浅→深的展开集', async () => {
  const f = writerFixture();
  f.w.noteTreeChange();
  f.fireTimer();
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(f.calls.length, 1);
  assert.deepStrictEqual(f.calls[0].expanded, ['/r/a', '/r/b']);
  assert.strictEqual(f.calls[0].gen, 1);
  assert.strictEqual(f.w.isDirty(), false);
});

test('0019/写者：打开文档直接写，⛔ 不被去抖窗口吞掉', async () => {
  const f = writerFixture({ currentPath: '/r/笔记/a.md' });
  f.w.noteDocOpen();
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].lastFile, '/r/笔记/a.md');
});

test('0064/写者：内容与镜像相同 ⇒ same，不发第二趟 IPC', async () => {
  const f = writerFixture({
    dirSessionGen: 1,
    dirSession: { last_file: null, expanded: ['/r/b', '/r/a'] },
  });
  f.w.noteTreeChange();
  assert.deepStrictEqual(await f.w.flush(), { status: 'same' });
  assert.strictEqual(f.calls.length, 0);
});

test('0064/写者：恢复事务期间 flush 挂起，dirty 不清', async () => {
  const f = writerFixture({ restoreToken: { cancelled: false } });
  f.w.noteDocOpen();
  assert.deepStrictEqual(await f.w.flush(), { status: 'suspended' });
  assert.strictEqual(f.w.isDirty(), true);
  assert.strictEqual(f.calls.length, 0);
  f.st.restoreToken.cancelled = true;
  await f.w.flush();
  await Promise.resolve();
  assert.strictEqual(f.calls.length, 1, '恢复结束后那一笔还得写出去');
});

test('0064/写者：非目录模式时忽略这次写，不留下“永远脏”', async () => {
  const f = writerFixture({ mode: 'single' });
  f.w.noteTreeChange();
  assert.deepStrictEqual(await f.w.flush(), { status: 'ignored' });
  assert.strictEqual(f.w.isDirty(), false);
  assert.strictEqual(f.calls.length, 0);
});

test('0064/写者：没有唯一根时同样忽略', async () => {
  const f = writerFixture({ roots: ['/a', '/b'] });
  f.w.noteTreeChange();
  assert.deepStrictEqual(await f.w.flush(), { status: 'ignored' });
  assert.strictEqual(f.calls.length, 0);
});

test('0067/写者：当前文档不在根下时保住镜像里的 last_file，不擦成 null', async () => {
  const f = writerFixture({
    currentPath: null,
    dirSessionGen: 1,
    dirSession: { last_file: '/r/上次.md', expanded: ['/r/a'] },
  });
  f.w.noteTreeChange();
  await f.w.flush();
  await Promise.resolve();
  assert.strictEqual(f.calls[0].lastFile, '/r/上次.md');
});

test('0067/写者：镜像本来也没有 last_file 时才写 null', async () => {
  const f = writerFixture({
    dirSessionGen: 1,
    dirSession: { last_file: null, expanded: ['/r/a'] },
  });
  f.w.noteTreeChange();
  await f.w.flush();
  await Promise.resolve();
  assert.strictEqual(f.calls[0].lastFile, null);
});

test('0019/写者：列表形态不写空 expanded，而是带回镜像', async () => {
  const f = writerFixture({
    sidebarFileView: 'list',
    currentPath: '/r/b.md',
    dirSessionGen: 1,
    dirSession: { last_file: '/r/a.md', expanded: ['/r/x', '/r/y'] },
  });
  f.w.noteTreeChange();
  await f.w.flush();
  await Promise.resolve();
  assert.deepStrictEqual(f.calls[0].expanded, ['/r/x', '/r/y']);
});

test('0019/写者：列表形态且镜像为空时写 []（后端本来就没有记录）', async () => {
  const f = writerFixture({ sidebarFileView: 'list', dirSession: null });
  f.w.noteTreeChange();
  await f.w.flush();
  await Promise.resolve();
  assert.deepStrictEqual(f.calls[0].expanded, []);
});

test('0064/写者：成功回包更新镜像与镜像代次', async () => {
  const f = writerFixture();
  f.setResponse({ status: 'ok', entry: { last_file: '/r/a.md', expanded: ['/r/a'], updated_at: 5 } });
  f.w.noteTreeChange();
  await f.w.flush();
  await Promise.resolve();
  assert.strictEqual(f.st.dirSession.last_file, '/r/a.md');
  assert.strictEqual(f.st.dirSessionGen, 1);
});

test('0064/写者：写失败置回 dirty，下一次还能再试', async () => {
  const f = writerFixture();
  f.setImpl(function () { return Promise.reject(new Error('写盘失败')); });
  f.w.noteTreeChange();
  const r = await f.w.flush();
  await Promise.resolve();
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(f.w.isDirty(), true);
});

test('0064/迟到回包：旧请求号的响应不覆盖新请求', async () => {
  const f = writerFixture();
  const releases = [];
  f.setImpl(function (root, gen, last, expanded) {
    return new Promise(function (resolve) { releases.push(resolve); });
  });
  f.w.noteDocOpen();
  await Promise.resolve();
  f.w.noteDocOpen();
  await Promise.resolve();
  assert.strictEqual(releases.length, 2);
  releases[0]({ status: 'ok', entry: { last_file: '/r/旧.md', expanded: [] } });
  releases[1]({ status: 'ok', entry: { last_file: '/r/新.md', expanded: [] } });
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(f.st.dirSession.last_file, '/r/新.md');
});

test('0064/迟到回包：响应回来时根代次已变 ⇒ 丢弃', async () => {
  const f = writerFixture();
  let release;
  f.setImpl(function () { return new Promise(function (resolve) { release = resolve; }); });
  f.w.noteDocOpen();
  await Promise.resolve();
  f.st.generation = 2;
  release({ status: 'ok', entry: { last_file: '/r/旧.md', expanded: ['/r/旧'] } });
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(f.st.dirSession, null);
  assert.strictEqual(f.st.dirSessionGen, 0);
});

test('0064/迟到回包：响应回来时根已换 ⇒ 丢弃（迟到 A 不倒灌进 B）', async () => {
  const f = writerFixture();
  let release;
  f.setImpl(function () { return new Promise(function (resolve) { release = resolve; }); });
  f.w.noteDocOpen();
  await Promise.resolve();
  f.st.roots = ['/other'];
  release({ status: 'ok', entry: { last_file: '/r/旧.md', expanded: [] } });
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(f.st.dirSession, null);
});
