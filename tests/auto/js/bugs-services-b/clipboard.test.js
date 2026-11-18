// clipboard 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：只读探针 → 唯一实现的映射、失败类别（unsupported / denied / failed）、
// execCommand 路径的 DOM 清理与焦点归还、⛔ 失败不自动换另一条路。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'clipboard.js'), 'utf8');

function loadClipboard() {
  const win = {};
  new Function('window', SRC)(win);
  return win.rmd.clipboard;
}

const CB = loadClipboard();

/** 造一个够用的假 document：body / createElement / execCommand / activeElement。 */
function makeDoc(opts) {
  const o = opts || {};
  const removed = [];
  const focused = [];
  const created = [];
  const body = {
    children: [],
    appendChild: function (el) {
      el.parentNode = body;
      body.children.push(el);
      return el;
    },
    removeChild: function (el) {
      removed.push(el);
      const i = body.children.indexOf(el);
      if (i >= 0) body.children.splice(i, 1);
      el.parentNode = null;
      return el;
    },
  };
  const doc = {
    body: body,
    execCommand: o.execCommand || function () { return true; },
    activeElement: o.activeElement || {
      focus: function () { focused.push(this); },
    },
    createElement: function (tag) {
      const el = {
        tag: tag,
        value: '',
        attrs: {},
        style: {},
        parentNode: null,
        selected: 0,
        setAttribute: function (k, v) { el.attrs[k] = v; },
        select: function () { el.selected += 1; },
      };
      created.push(el);
      return el;
    },
  };
  return { doc: doc, body: body, removed: removed, focused: focused, created: created };
}

function env(over) {
  return Object.assign({
    isSecureContext: false, hasClipboardWrite: false, hasExecCommand: false,
  }, over || {});
}

// ── 常量 ────────────────────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('三种模式与三种失败类别逐字锁死', () => {
  assert.strictEqual(CB.MODE_CLIPBOARD, 'clipboard');
  assert.strictEqual(CB.MODE_EXEC, 'exec');
  assert.strictEqual(CB.MODE_NONE, 'none');
  assert.strictEqual(CB.FAIL_UNSUPPORTED, 'unsupported');
  assert.strictEqual(CB.FAIL_DENIED, 'denied');
  assert.strictEqual(CB.FAIL_FAILED, 'failed');
});

// ── pickMode：只读能力 → 唯一一条实现 ────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('secure context + clipboard.writeText ⇒ 标准 API', () => {
  assert.strictEqual(CB.pickMode(env({ isSecureContext: true, hasClipboardWrite: true })), 'clipboard');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('非 secure context 时即使有 writeText 也不选它（按能力表退到 exec）', () => {
  assert.strictEqual(CB.pickMode(env({ isSecureContext: false, hasClipboardWrite: true, hasExecCommand: true })), 'exec');
  assert.strictEqual(CB.pickMode(env({ isSecureContext: false, hasClipboardWrite: true })), 'none');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('secure 但 writeText 缺失 ⇒ 退到 execCommand', () => {
  assert.strictEqual(CB.pickMode(env({ isSecureContext: true, hasClipboardWrite: false, hasExecCommand: true })), 'exec');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('两条都不可用 ⇒ none（⛔ 不假装能复制）', () => {
  assert.strictEqual(CB.pickMode(env()), 'none');
  assert.strictEqual(CB.pickMode(null), 'none');
  assert.strictEqual(CB.pickMode({}), 'none');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('判据是严格 === true：字符串 "true" / 1 都不算有能力', () => {
  assert.strictEqual(CB.pickMode({ isSecureContext: 'true', hasClipboardWrite: 'true' }), 'none');
  assert.strictEqual(CB.pickMode({ isSecureContext: 1, hasClipboardWrite: 1 }), 'none');
  assert.strictEqual(CB.pickMode({ hasExecCommand: 1 }), 'none');
});

// ── probe：只读 ────────────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('probe 只看三个布尔，不调用 writeText / execCommand', () => {
  let wrote = 0;
  let exec = 0;
  const win = {
    isSecureContext: true,
    navigator: { clipboard: { writeText: function () { wrote += 1; } } },
  };
  const doc = { execCommand: function () { exec += 1; return true; } };
  assert.deepStrictEqual(CB.probe(win, doc), {
    isSecureContext: true, hasClipboardWrite: true, hasExecCommand: true,
  });
  assert.strictEqual(wrote, 0);
  assert.strictEqual(exec, 0);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('probe：writeText 不是函数 ⇒ 没能力；isSecureContext 非严格 true ⇒ false', () => {
  const win = { isSecureContext: 'yes', navigator: { clipboard: { writeText: 'nope' } } };
  assert.deepStrictEqual(CB.probe(win, { execCommand: 'nope' }), {
    isSecureContext: false, hasClipboardWrite: false, hasExecCommand: false,
  });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('probe：空对象 / 缺 navigator / 缺 document 一律 false，⛔ 不抛', () => {
  assert.deepStrictEqual(CB.probe({}, {}), {
    isSecureContext: false, hasClipboardWrite: false, hasExecCommand: false,
  });
  assert.deepStrictEqual(CB.probe({ navigator: null }, { execCommand: null }), {
    isSecureContext: false, hasClipboardWrite: false, hasExecCommand: false,
  });
});

// ── capabilities：诊断不参与选路 ──────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('capabilities：没有 permissions API 时记 no-permissions-api，mode 照常算出', async () => {
  const win = { isSecureContext: true, navigator: { clipboard: { writeText: function () {} } } };
  const got = await CB.capabilities(win, {});
  assert.deepStrictEqual(got, {
    isSecureContext: true,
    hasClipboardWrite: true,
    hasExecCommand: false,
    permission: null,
    permissionError: 'no-permissions-api',
    mode: 'clipboard',
  });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('capabilities：query 成功时记下 state', async () => {
  const win = {
    navigator: {
      clipboard: { writeText: function () {} },
      permissions: { query: async function () { return { state: 'granted' }; } },
    },
  };
  const got = await CB.capabilities(win, {});
  assert.strictEqual(got.permission, 'granted');
  assert.strictEqual(got.permissionError, null);
  assert.strictEqual(got.mode, 'none', '非 secure context 不进 clipboard 模式');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('capabilities：query 抛错只记错误名，⛔ 不判成"不支持剪贴板"', async () => {
  const win = {
    navigator: {
      clipboard: { writeText: function () {} },
      permissions: { query: async function () { const e = new Error('bad'); e.name = 'TypeError'; throw e; } },
    },
  };
  const got = await CB.capabilities(win, {});
  assert.strictEqual(got.permissionError, 'TypeError');
  assert.strictEqual(got.hasClipboardWrite, true);
  assert.strictEqual(got.mode, 'none');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('capabilities：无 name 无 message 的拒绝记 query-failed；query 返回空记 null', async () => {
  const bad = {
    navigator: {
      clipboard: {},
      permissions: { query: function () { return Promise.reject({}); } },
    },
  };
  assert.strictEqual((await CB.capabilities(bad, {})).permissionError, 'query-failed');

  const empty = { navigator: { permissions: { query: async function () { return undefined; } } } };
  const got = await CB.capabilities(empty, {});
  assert.strictEqual(got.permission, null);
  assert.strictEqual(got.permissionError, null);
});

// ── createCopier：模式在开跑前选定 ────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('createCopier 的 mode 来自 env，不由运行期失败改写', () => {
  assert.strictEqual(CB.createCopier({ env: env({ hasExecCommand: true }) }).mode, 'exec');
  assert.strictEqual(CB.createCopier({ env: env() }).mode, 'none');
  assert.strictEqual(
    CB.createCopier({ env: env({ isSecureContext: true, hasClipboardWrite: true }) }).mode,
    'clipboard'
  );
});

// ── 通用输入校验 ──────────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('空串 / null / 非字符串 ⇒ failed，且不触碰任何实现', async () => {
  let calls = 0;
  const doc = makeDoc({ execCommand: function () { calls += 1; return true; } });
  const copier = CB.createCopier({ doc: doc.doc, env: env({ hasExecCommand: true }) });
  assert.deepStrictEqual(await copier.copy(''), { ok: false, reason: 'failed' });
  assert.deepStrictEqual(await copier.copy(null), { ok: false, reason: 'failed' });
  assert.deepStrictEqual(await copier.copy(42), { ok: false, reason: 'failed' });
  assert.strictEqual(calls, 0);
  assert.strictEqual(doc.created.length, 0);
});

// ── clipboard 模式 ────────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('clipboard 模式：writeText 成功后才返回 ok', async () => {
  const seen = [];
  const win = {
    isSecureContext: true,
    navigator: { clipboard: { writeText: async function (s) { seen.push(s); } } },
  };
  const copier = CB.createCopier({ win: win, env: env({ isSecureContext: true, hasClipboardWrite: true }) });
  assert.deepStrictEqual(await copier.copy('/a b/c.md'), { ok: true });
  assert.deepStrictEqual(seen, ['/a b/c.md']);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('clipboard 模式：NotAllowedError ⇒ denied，其它拒绝 ⇒ failed', async () => {
  const denied = {
    isSecureContext: true,
    navigator: { clipboard: { writeText: function () { const e = new Error('x'); e.name = 'NotAllowedError'; return Promise.reject(e); } } },
  };
  const other = {
    isSecureContext: true,
    navigator: { clipboard: { writeText: function () { return Promise.reject(new Error('boom')); } } },
  };
  const mk = function (win) {
    return CB.createCopier({ win: win, env: env({ isSecureContext: true, hasClipboardWrite: true }) });
  };
  assert.deepStrictEqual(await mk(denied).copy('x'), { ok: false, reason: 'denied' });
  assert.deepStrictEqual(await mk(other).copy('x'), { ok: false, reason: 'failed' });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('clipboard 模式失败后 ⛔ 不自动换 execCommand（判据翻倍）', async () => {
  let exec = 0;
  const doc = makeDoc({ execCommand: function () { exec += 1; return true; } });
  const win = {
    isSecureContext: true,
    navigator: { clipboard: { writeText: function () { return Promise.reject(new Error('boom')); } } },
  };
  const copier = CB.createCopier({
    win: win, doc: doc.doc,
    env: env({ isSecureContext: true, hasClipboardWrite: true, hasExecCommand: true }),
  });
  assert.deepStrictEqual(await copier.copy('x'), { ok: false, reason: 'failed' });
  assert.strictEqual(exec, 0);
  assert.strictEqual(doc.created.length, 0);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('clipboard 模式但 navigator 在运行期消失 ⇒ failed（现状如此）', async () => {
  // ⚠️ 疑似缺陷：选路时探到了 writeText，运行期对象消失却被归成 failed 而不是 unsupported。
  const win = { isSecureContext: true, navigator: null };
  const copier = CB.createCopier({ win: win, env: env({ isSecureContext: true, hasClipboardWrite: true }) });
  assert.deepStrictEqual(await copier.copy('x'), { ok: false, reason: 'failed' });
});

// ── exec 模式：DOM 细节与清理 ─────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('exec 模式：建 textarea、写值、只读、隐形、选中、调 copy、随后移除', async () => {
  const d = makeDoc();
  const copier = CB.createCopier({ doc: d.doc, env: env({ hasExecCommand: true }) });
  assert.deepStrictEqual(await copier.copy('/路径 带空格/a.md'), { ok: true });

  assert.strictEqual(d.created.length, 1);
  const ta = d.created[0];
  assert.strictEqual(ta.tag, 'textarea');
  assert.strictEqual(ta.value, '/路径 带空格/a.md');
  assert.strictEqual(ta.attrs.readonly, '');
  assert.strictEqual(ta.style.position, 'fixed');
  assert.strictEqual(ta.style.top, '0');
  assert.strictEqual(ta.style.left, '0');
  assert.strictEqual(ta.style.opacity, '0');
  assert.strictEqual(ta.style.pointerEvents, 'none');
  assert.strictEqual(ta.selected, 1);
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.body.children.length, 0);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('exec 模式：execCommand 返回 false ⇒ failed，textarea 仍被移除', async () => {
  const d = makeDoc({ execCommand: function () { return false; } });
  const copier = CB.createCopier({ doc: d.doc, env: env({ hasExecCommand: true }) });
  assert.deepStrictEqual(await copier.copy('x'), { ok: false, reason: 'failed' });
  assert.strictEqual(d.removed.length, 1);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('exec 模式：execCommand 抛错 ⇒ failed，⛔ 不抛给调用方', async () => {
  const d = makeDoc({ execCommand: function () { throw new Error('nope'); } });
  const copier = CB.createCopier({ doc: d.doc, env: env({ hasExecCommand: true }) });
  await assert.doesNotReject(async function () {
    assert.deepStrictEqual(await copier.copy('x'), { ok: false, reason: 'failed' });
  });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('exec 模式：复制后把焦点还给原元素（⛔ 不抢用户正在打字的焦点）', async () => {
  const d = makeDoc();
  const copier = CB.createCopier({ doc: d.doc, env: env({ hasExecCommand: true }) });
  await copier.copy('x');
  assert.deepStrictEqual(d.focused, [d.doc.activeElement]);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('exec 模式：失败路径同样归还焦点并清理节点', async () => {
  const d = makeDoc({ execCommand: function () { throw new Error('boom'); } });
  const copier = CB.createCopier({ doc: d.doc, env: env({ hasExecCommand: true }) });
  await copier.copy('x');
  assert.strictEqual(d.focused.length, 1);
  assert.strictEqual(d.removed.length, 1);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('exec 模式：createElement 抛错也安全，不会误报成功', async () => {
  const d = makeDoc();
  d.doc.createElement = function () { throw new Error('no dom'); };
  const copier = CB.createCopier({ doc: d.doc, env: env({ hasExecCommand: true }) });
  assert.deepStrictEqual(await copier.copy('x'), { ok: false, reason: 'failed' });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('exec 模式的 activeElement 不可聚焦时也安全', async () => {
  const d = makeDoc({ activeElement: {} });
  const copier = CB.createCopier({ doc: d.doc, env: env({ hasExecCommand: true }) });
  assert.deepStrictEqual(await copier.copy('x'), { ok: true });
});

// ── none 模式 ─────────────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('none 模式：如实报 unsupported，⛔ 不假装尝试过', async () => {
  const d = makeDoc();
  let writeCalls = 0;
  const win = { navigator: { clipboard: { writeText: function () { writeCalls += 1; } } } };
  const copier = CB.createCopier({ win: win, doc: d.doc, env: env() });
  assert.deepStrictEqual(await copier.copy('x'), { ok: false, reason: 'unsupported' });
  assert.strictEqual(d.created.length, 0);
  assert.strictEqual(writeCalls, 0);
});

// ── defaultCopier ─────────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('defaultCopier 惰性单例：两次拿到同一个对象', () => {
  assert.strictEqual(CB.defaultCopier(), CB.defaultCopier());
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('defaultCopier 在无浏览器环境里是 none 模式', () => {
  // 测试进程没有 window/document；产品路径不会在这里被调用
  assert.strictEqual(CB.defaultCopier().mode, 'none');
});
