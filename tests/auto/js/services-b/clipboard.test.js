// clipboard 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：只读能力探针、单一模式的选定（⛔ 不在运行期换实现）、
// 成功/拒绝/失败三态、execCommand 路径的清理与焦点归还、能力缺失。
// ⚠️ 真剪贴板一次都不碰：所有依赖都注入假 `window` / `document`。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadClipboard() {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'clipboard.js'), 'utf8');
  new Function('window', src)(win);
  return win.rmd.clipboard;
}

const C = loadClipboard();

function execDoc(opts) {
  const o = opts || {};
  const state = { appended: 0, removed: 0, selected: 0, focused: 0, copied: 0 };
  const ta = {
    value: '',
    style: {},
    attrs: {},
    parentNode: null,
    setAttribute: function (k, v) { this.attrs[k] = v; },
    select: function () { state.selected += 1; },
  };
  const body = {
    appendChild: function (n) { state.appended += 1; n.parentNode = body; },
    removeChild: function (n) { state.removed += 1; n.parentNode = null; },
  };
  const active = { focus: function () { state.focused += 1; } };
  const doc = {
    createElement: function () { return ta; },
    body: body,
    activeElement: o.noActive ? null : active,
    execCommand: function (cmd) {
      state.copied += 1;
      if (o.throwExec) throw new Error('exec 失败');
      return o.ok === undefined ? true : o.ok;
    },
  };
  return { doc: doc, ta: ta, active: active, state: state };
}

// ── pickMode ─────────────────────────────────────────────────────

test('pickMode：secure context ＋ writeText 在 ⇒ 标准 API', () => {
  assert.strictEqual(
    C.pickMode({ isSecureContext: true, hasClipboardWrite: true, hasExecCommand: true }),
    C.MODE_CLIPBOARD
  );
});

test('pickMode：不是 secure context 但有 execCommand ⇒ exec（跑之前就选定）', () => {
  assert.strictEqual(
    C.pickMode({ isSecureContext: false, hasClipboardWrite: true, hasExecCommand: true }),
    C.MODE_EXEC
  );
});

test('pickMode：两条都不可用 ⇒ none', () => {
  assert.strictEqual(C.pickMode({}), C.MODE_NONE);
  assert.strictEqual(C.pickMode(undefined), C.MODE_NONE);
});

test('pickMode：只认 === true，真值字符串/数字不算“有”', () => {
  assert.strictEqual(
    C.pickMode({ isSecureContext: 'true', hasClipboardWrite: 1, hasExecCommand: true }),
    C.MODE_EXEC
  );
  assert.strictEqual(
    C.pickMode({ isSecureContext: true, hasClipboardWrite: 1, hasExecCommand: false }),
    C.MODE_NONE
  );
});

// ── probe ────────────────────────────────────────────────────────

test('probe：只读——一次都不调 writeText / readText / execCommand', () => {
  let writes = 0;
  let reads = 0;
  let execs = 0;
  const win = {
    isSecureContext: true,
    navigator: {
      clipboard: {
        writeText: function () { writes += 1; return Promise.resolve(); },
        readText: function () { reads += 1; return Promise.resolve(''); },
      },
    },
  };
  const doc = { execCommand: function () { execs += 1; return true; } };
  const env = C.probe(win, doc);
  assert.deepStrictEqual(env, {
    isSecureContext: true,
    hasClipboardWrite: true,
    hasExecCommand: true,
  });
  assert.deepStrictEqual([writes, reads, execs], [0, 0, 0]);
});

test('probe：环境缺东西时逐项为假且不抛', () => {
  assert.deepStrictEqual(C.probe({}, {}), {
    isSecureContext: false,
    hasClipboardWrite: false,
    hasExecCommand: false,
  });
});

test('probe：isSecureContext 只认 === true', () => {
  assert.strictEqual(C.probe({ isSecureContext: 'yes' }, {}).isSecureContext, false);
});

// ── capabilities ─────────────────────────────────────────────────

test('capabilities：permission 查询成功时记下 state', async () => {
  const win = {
    isSecureContext: true,
    navigator: {
      clipboard: { writeText: function () { return Promise.resolve(); } },
      permissions: { query: async function () { return { state: 'granted' }; } },
    },
  };
  const got = await C.capabilities(win, {});
  assert.strictEqual(got.permission, 'granted');
  assert.strictEqual(got.permissionError, null);
  assert.strictEqual(got.mode, C.MODE_CLIPBOARD);
});

test('capabilities：查询抛错时记下错误名，⛔ 不当成“不支持剪贴板”', async () => {
  const win = {
    navigator: {
      permissions: { query: async function () { throw { name: 'TypeError' }; } },
    },
  };
  const got = await C.capabilities(win, {});
  assert.strictEqual(got.permission, null);
  assert.strictEqual(got.permissionError, 'TypeError');
  assert.strictEqual(got.mode, C.MODE_NONE);
});

test('capabilities：没有 permissions API 时记 no-permissions-api', async () => {
  const got = await C.capabilities({}, {});
  assert.strictEqual(got.permissionError, 'no-permissions-api');
});

// ── copy：clipboard 路径 ──────────────────────────────────────────

function clipboardWin() {
  const writes = [];
  let resolveWrite = null;
  let rejectWrite = null;
  const win = {
    isSecureContext: true,
    navigator: {
      clipboard: {
        writeText: function (text) {
          writes.push(text);
          return new Promise(function (resolve, reject) {
            resolveWrite = resolve;
            rejectWrite = reject;
          });
        },
      },
    },
  };
  return {
    win: win,
    writes: writes,
    resolve: function () { resolveWrite(); },
    reject: function (err) { rejectWrite(err); },
  };
}

test('copy（clipboard）：文本逐字传进去，且等到真写完才报成功', async () => {
  const h = clipboardWin();
  const c = C.createCopier({ win: h.win, doc: {}, env: C.probe(h.win, {}) });
  let settled = false;
  const p = c.copy('第一行\n第二行').then(function (r) { settled = true; return r; });
  await Promise.resolve();
  assert.strictEqual(settled, false, '写入还没完成就报“已复制”是假报');
  h.resolve();
  const r = await p;
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(h.writes, ['第一行\n第二行']);
});

test('copy（clipboard）：NotAllowedError ⇒ denied', async () => {
  const h = clipboardWin();
  const c = C.createCopier({ win: h.win, doc: {}, env: C.probe(h.win, {}) });
  const p = c.copy('x');
  h.reject({ name: 'NotAllowedError' });
  assert.deepStrictEqual(await p, { ok: false, reason: C.FAIL_DENIED });
});

test('copy（clipboard）：别的错误 ⇒ failed', async () => {
  const h = clipboardWin();
  const c = C.createCopier({ win: h.win, doc: {}, env: C.probe(h.win, {}) });
  const p = c.copy('x');
  h.reject(new Error('boom'));
  assert.deepStrictEqual(await p, { ok: false, reason: C.FAIL_FAILED });
});

test('copy（clipboard）：失败后⛔ 不自动换 execCommand', async () => {
  const h = clipboardWin();
  let execs = 0;
  const doc = { execCommand: function () { execs += 1; return true; } };
  const c = C.createCopier({ win: h.win, doc: doc, env: C.probe(h.win, doc) });
  const p = c.copy('x');
  h.reject(new Error('boom'));
  await p;
  assert.strictEqual(execs, 0);
});

// ── copy：exec 路径 ──────────────────────────────────────────────

test('copy（exec）：成功时建节点、选中、复制、清理并把焦点还回去', async () => {
  const d = execDoc();
  const c = C.createCopier({
    win: {},
    doc: d.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: true },
  });
  const r = await c.copy('abc');
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(d.ta.value, 'abc');
  assert.strictEqual(d.ta.attrs.readonly, '');
  assert.strictEqual(d.ta.style.position, 'fixed');
  assert.strictEqual(d.ta.style.opacity, '0');
  assert.deepStrictEqual(d.state, { appended: 1, removed: 1, selected: 1, focused: 1, copied: 1 });
});

test('copy（exec）：execCommand 返回 false ⇒ failed，⛔ 不说“已复制”', async () => {
  const d = execDoc({ ok: false });
  const c = C.createCopier({
    win: {}, doc: d.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: true },
  });
  assert.deepStrictEqual(await c.copy('abc'), { ok: false, reason: C.FAIL_FAILED });
  assert.strictEqual(d.state.removed, 1);
  assert.strictEqual(d.state.focused, 1);
});

test('copy（exec）：execCommand 抛错 ⇒ failed，照样清理与还焦点', async () => {
  const d = execDoc({ throwExec: true });
  const c = C.createCopier({
    win: {}, doc: d.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: true },
  });
  assert.deepStrictEqual(await c.copy('abc'), { ok: false, reason: C.FAIL_FAILED });
  assert.strictEqual(d.state.removed, 1);
  assert.strictEqual(d.state.focused, 1);
});

test('copy（exec）：原焦点已经消失或 focus 抛错都不影响复制结果', async () => {
  const d = execDoc({ noActive: true });
  const c = C.createCopier({
    win: {}, doc: d.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: true },
  });
  assert.deepStrictEqual(await c.copy('abc'), { ok: true });

  const d2 = execDoc();
  d2.active.focus = function () { throw new Error('焦点没了'); };
  const c2 = C.createCopier({
    win: {}, doc: d2.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: true },
  });
  assert.deepStrictEqual(await c2.copy('abc'), { ok: true });
});

// ── copy：能力缺失 / 非法输入 ────────────────────────────────────

test('copy（none）：能力缺失 ⇒ unsupported，且⛔ 不碰 DOM', async () => {
  const d = execDoc();
  const c = C.createCopier({
    win: {}, doc: d.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: false },
  });
  assert.deepStrictEqual(await c.copy('abc'), { ok: false, reason: C.FAIL_UNSUPPORTED });
  assert.deepStrictEqual(d.state, { appended: 0, removed: 0, selected: 0, focused: 0, copied: 0 });
});

test('copy：空串与非字符串一律 failed（⛔ 往剪贴板写空串）', async () => {
  const h = clipboardWin();
  const c = C.createCopier({ win: h.win, doc: {}, env: C.probe(h.win, {}) });
  assert.deepStrictEqual(await c.copy(''), { ok: false, reason: C.FAIL_FAILED });
  assert.deepStrictEqual(await c.copy(123), { ok: false, reason: C.FAIL_FAILED });
  assert.deepStrictEqual(h.writes, []);
});

// ── 构造与导出 ───────────────────────────────────────────────────

test('createCopier：没给 env 时按注入的 window / document 现探一次', () => {
  const win = {
    isSecureContext: true,
    navigator: { clipboard: { writeText: function () { return Promise.resolve(); } } },
  };
  const c = C.createCopier({ win: win, doc: {} });
  assert.strictEqual(c.mode, C.MODE_CLIPBOARD);
});

test('defaultCopier：惰性单例，同一份环境只建一次', () => {
  const a = C.defaultCopier();
  const b = C.defaultCopier();
  assert.strictEqual(a, b);
});
