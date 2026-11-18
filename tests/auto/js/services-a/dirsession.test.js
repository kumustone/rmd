// 目录会话纯逻辑（`src/services/dirsession.js`）的补充用例。
//
// 判据全在这里：包含关系（前缀陷阱）、文档身份、展开集的整理、恢复事务与写者。
// 它们错一个的表现都是“上次的展开态/文件不见了”或“切根后旧响应倒灌”，
// 而屏幕上一个错误都不会有。
//
// ⚠️ 模块挂在 `window.rmd.dirSession`（大写 S），不是 `dircsession`。
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

// ─────────────────────────────────────────────────────────────────────────
// isInside / docInRoot
// ─────────────────────────────────────────────────────────────────────────

test('isInside：相等、父子、尾斜杠都算在里面', () => {
  assert.strictEqual(D.isInside('/a', '/a'), true);
  assert.strictEqual(D.isInside('/a', '/a/b'), true);
  assert.strictEqual(D.isInside('/a/', '/a/b'), true);
  assert.strictEqual(D.isInside('/', '/a'), true);
  assert.strictEqual(D.isInside('/a/b', '/a/b/c/d'), true);
});

test('isInside：rootfoo 不算在 root 里（前缀陷阱）', () => {
  assert.strictEqual(D.isInside('/a', '/ab'), false);
  assert.strictEqual(D.isInside('/a', '/a-b'), false);
  assert.strictEqual(D.isInside('/a/b', '/a/bc'), false);
});

test('isInside：空值一律为假，⛔ 不把空串当根', () => {
  assert.strictEqual(D.isInside('', '/a'), false);
  assert.strictEqual(D.isInside('/a', ''), false);
  assert.strictEqual(D.isInside(null, '/a'), false);
  assert.strictEqual(D.isInside('/a', null), false);
});

test('docInRoot：只有目录模式、当前文档在根下且不等于根才算', () => {
  const st = { mode: 'directory', currentPath: '/r/a.md' };
  assert.strictEqual(D.docInRoot(st, '/r'), true);
  assert.strictEqual(D.docInRoot({ mode: 'single', currentPath: '/r/a.md' }, '/r'), false);
  assert.strictEqual(D.docInRoot({ mode: 'directory', currentPath: '/r' }, '/r'), false);
  assert.strictEqual(D.docInRoot({ mode: 'directory', currentPath: '' }, '/r'), false);
  assert.strictEqual(D.docInRoot({ mode: 'directory', currentPath: '/other/a.md' }, '/r'), false);
  assert.strictEqual(D.docInRoot(null, '/r'), false);
});

// ─────────────────────────────────────────────────────────────────────────
// toEntry
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

test('toEntry：去重，并让浅的、字面序小的排在前面', () => {
  const r = D.toEntry('/r', null, ['/r/b/c', '/r/a', '/r/a', '/r/b']);
  assert.deepStrictEqual(r.entry.expanded, ['/r/a', '/r/b', '/r/b/c']);
});

test('toEntry：超过 200 条时截断，截掉的那些进 dropped', () => {
  const many = [];
  for (let i = 0; i < 205; i++) many.push('/r/d' + String(i).padStart(3, '0'));
  const r = D.toEntry('/r', null, many);
  assert.strictEqual(r.entry.expanded.length, D.MAX_EXPANDED_PER_DIR);
  assert.strictEqual(r.dropped.length, 5);
});

test('toEntry：last_file 三种坏值都置 null 并记账', () => {
  assert.strictEqual(D.toEntry('/r', '/other/a.md', []).entry.last_file, null);
  assert.strictEqual(D.toEntry('/r', '/r', []).entry.last_file, null);
  assert.strictEqual(D.toEntry('/r', 7, []).entry.last_file, null);
  assert.strictEqual(D.toEntry('/r', '/r/a.md', []).entry.last_file, '/r/a.md');
  assert.deepStrictEqual(D.toEntry('/r', '/other/a.md', []).dropped, ['/other/a.md']);
});

test('toEntry：单条路径按码点数封顶 4096，超限整条丢', () => {
  const ok = '/r/' + '中'.repeat(D.MAX_SESSION_PATH_CHARS - 3);
  const tooLong = '/r/' + '中'.repeat(D.MAX_SESSION_PATH_CHARS - 2);
  assert.strictEqual(D.toEntry('/r', null, [ok]).entry.expanded.length, 1);
  const r = D.toEntry('/r', null, [tooLong]);
  assert.deepStrictEqual(r.entry.expanded, []);
  assert.strictEqual(r.dropped.length, 1);
});

test('toEntry：expanded 非数组 / 非 Set 时按空处理', () => {
  assert.deepStrictEqual(D.toEntry('/r', null, null).entry.expanded, []);
  assert.deepStrictEqual(D.toEntry('/r', null, 'x').entry.expanded, []);
});

// ─────────────────────────────────────────────────────────────────────────
// restorePlan / sameEntry / shouldRestore
// ─────────────────────────────────────────────────────────────────────────

test('restorePlan：由浅到深、去重、丢越界与非字符串', () => {
  const plan = D.restorePlan({
    expanded: ['/r/b/c', '/r/a', '/r/a', '/other/x', null],
    last_file: '/r/a.md',
  }, '/r');
  assert.deepStrictEqual(plan.dirs, ['/r/a', '/r/b/c']);
  assert.strictEqual(plan.file, '/r/a.md');
});

test('restorePlan：entry / root 缺失时返回空计划，file 越界为 null', () => {
  assert.deepStrictEqual(D.restorePlan(null, '/r'), { dirs: [], file: null });
  assert.deepStrictEqual(D.restorePlan({ expanded: ['/r/a'] }, null), { dirs: [], file: null });
  assert.deepStrictEqual(
    D.restorePlan({ expanded: ['/r/a'], last_file: '/other/a.md' }, '/r'),
    { dirs: ['/r/a'], file: null }
  );
});

test('restorePlan：展开集超过上限时截断', () => {
  const many = [];
  for (let i = 0; i < 205; i++) many.push('/r/d' + String(i).padStart(3, '0'));
  const plan = D.restorePlan({ expanded: many }, '/r');
  assert.strictEqual(plan.dirs.length, D.MAX_EXPANDED_PER_DIR);
});

test('sameEntry：只差 updated_at / 顺序视为相同', () => {
  assert.strictEqual(D.sameEntry(null, null), true);
  assert.strictEqual(D.sameEntry(null, {}), false);
  assert.strictEqual(D.sameEntry({}, null), false);
  assert.strictEqual(
    D.sameEntry(
      { last_file: '/r/a.md', expanded: ['/r/a', '/r/b'], updated_at: 1 },
      { last_file: '/r/a.md', expanded: ['/r/b', '/r/a'], updated_at: 99 }
    ),
    true
  );
});

test('sameEntry：last_file 或展开集长度不同即不同', () => {
  assert.strictEqual(
    D.sameEntry({ last_file: '/r/a.md', expanded: [] },
      { last_file: null, expanded: [] }),
    false
  );
  assert.strictEqual(
    D.sameEntry({ last_file: null, expanded: ['/r/a'] },
      { last_file: null, expanded: [] }),
    false
  );
  // 非数组 expanded 按空处理
  assert.strictEqual(
    D.sameEntry({ last_file: null, expanded: 'x' }, { last_file: null, expanded: [] }),
    true
  );
});

test('shouldRestore：目录模式 + 有会话 + 这一代还没恢复过', () => {
  const base = { mode: 'directory', dirSession: {}, generation: 3, restoredGen: 2 };
  assert.strictEqual(D.shouldRestore(base), true);
  assert.strictEqual(D.shouldRestore(Object.assign({}, base, { restoredGen: 3 })), false);
  assert.strictEqual(D.shouldRestore(Object.assign({}, base, { mode: 'single' })), false);
  assert.strictEqual(D.shouldRestore(Object.assign({}, base, { dirSession: null })), false);
  assert.strictEqual(D.shouldRestore(null), false);
});

// ─────────────────────────────────────────────────────────────────────────
// createWriter：脏标记、去抖、挂起、回填闸
// ─────────────────────────────────────────────────────────────────────────

function mkState(over) {
  return Object.assign({
    mode: 'directory',
    generation: 1,
    roots: ['/r'],
    currentPath: '/r/a.md',
    dirSession: null,
    dirSessionGen: 0,
    sidebarFileView: 'tree',
    restoreToken: null,
  }, over || {});
}

function mkWriter(st, over) {
  const o = over || {};
  const timers = [];
  const calls = [];
  const writer = D.createWriter({
    getState: function () { return st; },
    tree: { expanded: new Set(o.expanded || ['/r/x']) },
    setDirSession: function (root, gen, last, expanded) {
      calls.push({ root: root, gen: gen, last: last, expanded: expanded });
      if (o.reject) return Promise.reject(new Error('写失败'));
      return Promise.resolve({
        status: 'saved',
        entry: { last_file: last, expanded: expanded, updated_at: 1 },
      });
    },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: function () { /* 由 flush 自己保证不重复执行 */ },
  });
  return { writer: writer, calls: calls, timers: timers };
}

test('writer：树变了只置脏并排一次去抖，不立即写', () => {
  const st = mkState();
  const w = mkWriter(st);
  w.writer.noteTreeChange();
  assert.strictEqual(w.writer.isDirty(), true);
  assert.strictEqual(w.timers.length, 1);
  assert.strictEqual(w.timers[0].ms, D.DIR_SESSION_DEBOUNCE_MS);
  assert.strictEqual(w.calls.length, 0);
});

test('writer：没有变化时 flush 是 clean，不发 IPC', async () => {
  const st = mkState();
  const w = mkWriter(st);
  assert.deepStrictEqual(await w.writer.flush(), { status: 'clean' });
  assert.strictEqual(w.calls.length, 0);
});

test('writer：noteDocOpen 直接写，⛔ 不被去抖窗口吞掉', async () => {
  const st = mkState();
  const w = mkWriter(st);
  await w.writer.noteDocOpen();
  assert.strictEqual(w.calls.length, 1);
  assert.strictEqual(w.calls[0].last, '/r/a.md');
  assert.deepStrictEqual(w.calls[0].expanded, ['/r/x']);
});

test('writer：恢复期挂起，dirty 不清，恢复结束后还能写出去', async () => {
  const st = mkState();
  const w = mkWriter(st);
  w.writer.noteTreeChange();
  st.restoreToken = { cancelled: false };
  assert.deepStrictEqual(await w.writer.flush(), { status: 'suspended' });
  assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(w.writer.isDirty(), true, '挂起时把脏标记抹了');
  st.restoreToken = null;
  await w.writer.flush();
  assert.strictEqual(w.calls.length, 1);
});

test('writer：内容与镜像相同则 same，不发 IPC', async () => {
  const st = mkState({
    dirSession: { last_file: '/r/a.md', expanded: ['/r/x'] },
    dirSessionGen: 1,
  });
  const w = mkWriter(st);
  w.writer.noteTreeChange();
  assert.deepStrictEqual(await w.writer.flush(), { status: 'same' });
  assert.strictEqual(w.calls.length, 0);
});

test('writer：成功回包写回镜像，并记下属于哪一代', async () => {
  const st = mkState();
  const w = mkWriter(st);
  await w.writer.noteDocOpen();
  assert.strictEqual(st.dirSession.last_file, '/r/a.md');
  assert.strictEqual(st.dirSessionGen, 1);
});

test('writer：当前文档不在根下时保住镜像里的 last_file（⛔ 不写 null）', async () => {
  const st = mkState({
    currentPath: null,
    dirSession: { last_file: '/r/old.md', expanded: ['/r/x'] },
    dirSessionGen: 1,
  });
  // 树里的展开集变了（空），所以这次真的会写；last_file 应取镜像而不是 null。
  const w = mkWriter(st, { expanded: [] });
  w.writer.noteTreeChange();
  await w.writer.flush();
  assert.strictEqual(w.calls[0].last, '/r/old.md');
});

test('writer：非目录模式 / 没有唯一的根时忽略这次写', async () => {
  const st = mkState({ mode: 'single' });
  const w = mkWriter(st);
  w.writer.noteTreeChange();
  assert.deepStrictEqual(await w.writer.flush(), { status: 'ignored' });
  assert.strictEqual(w.calls.length, 0);
});

test('writer：写失败时置回 dirty，下一次还能重试', async () => {
  const st = mkState();
  const w = mkWriter(st, { reject: true });
  await w.writer.noteDocOpen();
  assert.strictEqual(w.writer.isDirty(), true);
  assert.strictEqual(w.calls.length, 1);
});

test('writer：列表形态的 expanded 取镜像，⛔ 不写空数组抹掉记录', async () => {
  const st = mkState({
    currentPath: '/r/new.md',
    sidebarFileView: 'list',
    dirSession: { last_file: '/r/old.md', expanded: ['/r/x', '/r/y'] },
    dirSessionGen: 1,
  });
  const w = mkWriter(st, { expanded: [] });
  await w.writer.noteDocOpen();
  assert.deepStrictEqual(w.calls[0].expanded, ['/r/x', '/r/y']);
});
