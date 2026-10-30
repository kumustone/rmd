// `design/0035` §2.3 / §2.4：剪贴板的**只读能力核对**与**唯一一条写入实现**。
//
// ⚠️ 这一份**从不碰真剪贴板**：`win` / `doc` / `env` 全部是假的，
//    `writeText` / `execCommand` / `readText` 都只是记录调用的桩子。
//    ⭐ 这是硬约束——`make test-js` 会在**用户的真机上**跑，而用户明确要求
//    「不自动运行会写用户剪贴板的验证」（根 `CLAUDE.md` §4 同族）。
//
// ⚠️ 这里钉的都是**静默**错法：
//    ① 探针真去调 `writeText` ⇒ **覆盖了用户真实剪贴板**，而界面上一切正常；
//    ② 失败后自动换另一条路 ⇒ "走哪条"变成运行期随机，判据翻倍；
//    ③ 没等到写入完成就报"已复制" ⇒ 复制其实失败了、用户粘出来是旧内容；
//    ④ `execCommand` 那条路不还焦点 ⇒ 复制一下把用户正在打字的焦点抢走。

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const C = require('../../src/services/clipboard.js');

// ── 假环境（⛔ 全部在内存里，不碰真剪贴板） ───────────────────────────

/**
 * 假 `document`。
 * @param {{execResult?:boolean, execThrows?:boolean, activeElement?:object|null}} o
 */
function makeDoc(o) {
  const opts = o || {};
  const calls = [];
  const ta = {
    value: '',
    style: {},
    attrs: {},
    parentNode: null,
    setAttribute: function (k, v) { ta.attrs[k] = v; },
    select: function () { calls.push('select'); },
  };
  const active = {
    focusCount: 0,
    focus: function () { active.focusCount++; calls.push('restore-focus'); },
  };
  const body = {
    appendChild: function (node) { node.parentNode = body; calls.push('append'); },
    removeChild: function (node) { node.parentNode = null; calls.push('remove'); },
  };
  const doc = {
    activeElement: opts.activeElement === undefined ? active : opts.activeElement,
    body: body,
    createElement: function (tag) { calls.push('createElement:' + tag); return ta; },
    execCommand: function (cmd) {
      calls.push('exec:' + cmd);
      if (opts.execThrows) throw new Error('boom');
      return opts.execResult === undefined ? true : opts.execResult;
    },
  };
  return { doc: doc, ta: ta, active: active, calls: calls };
}

/** 假 `window`（`writeText` 行为由调用方给）。 */
function makeWin(writeText) {
  return {
    isSecureContext: true,
    navigator: { clipboard: { writeText: writeText } },
  };
}

/** 记下每次 `writeText` 的入参，并立即成功。 */
function recordingWin() {
  const seen = [];
  const win = makeWin(function (text) { seen.push(text); return Promise.resolve(); });
  return { win: win, seen: seen };
}

// ── `pickMode`：只读能力 ⇒ **唯一一种**实现 ──────────────────────────

test('pickMode：secure context ＋ writeText 在 ⇒ 标准 API', function () {
  assert.strictEqual(
    C.pickMode({ isSecureContext: true, hasClipboardWrite: true, hasExecCommand: false }),
    C.MODE_CLIPBOARD
  );
});

test('pickMode：不是 secure context ⇒ 退到 execCommand（跑之前就选定，⛔ 不是失败回退）', function () {
  assert.strictEqual(
    C.pickMode({ isSecureContext: false, hasClipboardWrite: true, hasExecCommand: true }),
    C.MODE_EXEC
  );
});

test('pickMode：两条都没有 ⇒ none（如实说"不支持"）', function () {
  assert.strictEqual(
    C.pickMode({ isSecureContext: false, hasClipboardWrite: false, hasExecCommand: false }),
    C.MODE_NONE
  );
  assert.strictEqual(C.pickMode(), C.MODE_NONE);
});

test('pickMode：⚠️ 只认 `=== true`——`"false"` / `1` 这类真值不许被读成"有"', function () {
  assert.strictEqual(
    C.pickMode({ isSecureContext: 'false', hasClipboardWrite: 'false', hasExecCommand: 1 }),
    C.MODE_NONE
  );
  // 单独看每一项：字符串 `"true"` 也不算
  assert.strictEqual(
    C.pickMode({ isSecureContext: 'true', hasClipboardWrite: true, hasExecCommand: false }),
    C.MODE_NONE
  );
});

// ── `probe`：**只读** ────────────────────────────────────────────────

test('probe：只读——⛔ 不调 writeText / readText / execCommand', function () {
  const calls = [];
  const win = {
    isSecureContext: true,
    navigator: {
      clipboard: {
        writeText: function () { calls.push('writeText'); return Promise.resolve(); },
        readText: function () { calls.push('readText'); return Promise.resolve(''); },
      },
    },
  };
  const doc = { execCommand: function () { calls.push('execCommand'); return true; } };
  const env = C.probe(win, doc);
  assert.deepStrictEqual(env, {
    isSecureContext: true,
    hasClipboardWrite: true,
    hasExecCommand: true,
  });
  assert.deepStrictEqual(calls, [], '⚠️ 探针一旦真写一次，用户的剪贴板就被覆盖了');
});

test('probe：环境缺东西时逐项为假（⛔ 不抛）', function () {
  assert.deepStrictEqual(C.probe(null, null), {
    isSecureContext: false,
    hasClipboardWrite: false,
    hasExecCommand: false,
  });
  assert.deepStrictEqual(C.probe({}, {}), {
    isSecureContext: false,
    hasClipboardWrite: false,
    hasExecCommand: false,
  });
});

// ── `capabilities`：权限查询只是**诊断**，不改变模式 ─────────────────

test('capabilities：permission 查询成功 ⇒ 记下 state，mode 照旧', async function () {
  const win = makeWin(function () { return Promise.resolve(); });
  win.navigator.permissions = {
    query: function (d) {
      assert.deepStrictEqual(d, { name: 'clipboard-write' });
      return Promise.resolve({ state: 'granted' });
    },
  };
  const env = await C.capabilities(win, makeDoc().doc);
  assert.strictEqual(env.permission, 'granted');
  assert.strictEqual(env.permissionError, null);
  assert.strictEqual(env.mode, C.MODE_CLIPBOARD);
});

test('capabilities：⚠️ 查询**抛**（WebKit 对不认识的 permission 名会这样）⇒ 记错误，⛔ 不当成不支持', async function () {
  const win = makeWin(function () { return Promise.resolve(); });
  const boom = new Error('unknown');
  boom.name = 'TypeError';
  win.navigator.permissions = { query: function () { return Promise.reject(boom); } };
  const env = await C.capabilities(win, makeDoc().doc);
  assert.strictEqual(env.permission, null);
  assert.strictEqual(env.permissionError, 'TypeError');
  assert.strictEqual(env.mode, C.MODE_CLIPBOARD, '⚠️ 查询不可用 ≠ 剪贴板不可用');
});

test('capabilities：没有 permissions API ⇒ 记 no-permissions-api', async function () {
  const env = await C.capabilities(makeWin(function () { return Promise.resolve(); }), makeDoc().doc);
  assert.strictEqual(env.permissionError, 'no-permissions-api');
});

// ── 标准 API 那条路 ─────────────────────────────────────────────────

test('copy（clipboard）：纯字符串原样传进去（逐字节）', async function () {
  const r = recordingWin();
  const copier = C.createCopier({
    win: r.win,
    doc: makeDoc().doc,
    env: { isSecureContext: true, hasClipboardWrite: true, hasExecCommand: false },
  });
  const out = await copier.copy('/root/有空 格/"q".md');
  assert.deepStrictEqual(out, { ok: true });
  assert.deepStrictEqual(r.seen, ['/root/有空 格/"q".md']);
});

test('copy（clipboard）：⚠️ 等到写入**真完成**才报成功', async function () {
  let resolveWrite;
  const pending = new Promise(function (res) { resolveWrite = res; });
  const r = makeWin(function () { return pending; });
  const copier = C.createCopier({
    win: r,
    doc: makeDoc().doc,
    env: { isSecureContext: true, hasClipboardWrite: true, hasExecCommand: false },
  });
  let settled = null;
  const p = copier.copy('/a.md').then(function (v) { settled = v; return v; });
  await Promise.resolve();
  assert.strictEqual(settled, null, '⚠️ 写还没完成就说成功 ⇒ 用户粘出来是旧内容');
  resolveWrite();
  assert.deepStrictEqual(await p, { ok: true });
});

test('copy（clipboard）：NotAllowedError ⇒ denied', async function () {
  const err = new Error('denied');
  err.name = 'NotAllowedError';
  const copier = C.createCopier({
    win: makeWin(function () { return Promise.reject(err); }),
    doc: makeDoc().doc,
    env: { isSecureContext: true, hasClipboardWrite: true, hasExecCommand: false },
  });
  assert.deepStrictEqual(await copier.copy('/a.md'), { ok: false, reason: C.FAIL_DENIED });
});

test('copy（clipboard）：⚠️ 别的错误 ⇒ failed，且**不换** execCommand（⛔ 运行期回退）', async function () {
  const doc = makeDoc();
  const copier = C.createCopier({
    win: makeWin(function () { return Promise.reject(new Error('boom')); }),
    doc: doc.doc,
    env: { isSecureContext: true, hasClipboardWrite: true, hasExecCommand: true },
  });
  assert.deepStrictEqual(await copier.copy('/a.md'), { ok: false, reason: C.FAIL_FAILED });
  assert.deepStrictEqual(doc.calls, [], '两条路只能**开跑前选定**一条（§2.3 第 2 条）');
});

// ── `execCommand` 那条路 ────────────────────────────────────────────

test('copy（exec）：execCommand 真 ⇒ ok，并且清掉临时节点、把焦点还回去', async function () {
  const d = makeDoc();
  const copier = C.createCopier({
    win: { isSecureContext: false, navigator: {} },
    doc: d.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: true },
  });
  const out = await copier.copy('/root/a.md');
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(d.ta.value, '/root/a.md', '选中的是**值**，⛔ 不是用户的界面');
  assert.strictEqual(d.ta.parentNode, null, '临时 textarea 必须被移除');
  assert.strictEqual(d.active.focusCount, 1, '⚠️ 不还焦点 = 复制一下把用户正在打字的焦点抢走');
  assert.ok(d.calls.indexOf('append') >= 0);
  assert.ok(d.calls.indexOf('remove') >= 0);
});

test('copy（exec）：execCommand 返回 false ⇒ failed（⛔ 说成"已复制"）', async function () {
  const d = makeDoc({ execResult: false });
  const copier = C.createCopier({
    win: {},
    doc: d.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: true },
  });
  assert.deepStrictEqual(await copier.copy('/a.md'), { ok: false, reason: C.FAIL_FAILED });
  assert.strictEqual(d.active.focusCount, 1, '失败也要还焦点');
});

test('copy（exec）：execCommand **抛** ⇒ failed，且照样清理 + 还焦点', async function () {
  const d = makeDoc({ execThrows: true });
  const copier = C.createCopier({
    win: {},
    doc: d.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: true },
  });
  assert.deepStrictEqual(await copier.copy('/a.md'), { ok: false, reason: C.FAIL_FAILED });
  assert.strictEqual(d.ta.parentNode, null);
  assert.strictEqual(d.active.focusCount, 1);
});

test('copy（exec）：没有原来的焦点 ⇒ 不抛', async function () {
  const d = makeDoc({ activeElement: null });
  const copier = C.createCopier({
    win: {},
    doc: d.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: true },
  });
  assert.deepStrictEqual(await copier.copy('/a.md'), { ok: true });
});

// ── 能力缺失 / 空输入 ───────────────────────────────────────────────

test('copy（none）：⚠️ 能力缺失 ⇒ unsupported，且⛔ 不碰 DOM（不假装尝试过）', async function () {
  const d = makeDoc();
  const copier = C.createCopier({
    win: {},
    doc: d.doc,
    env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: false },
  });
  assert.strictEqual(copier.mode, C.MODE_NONE);
  assert.deepStrictEqual(await copier.copy('/a.md'), { ok: false, reason: C.FAIL_UNSUPPORTED });
  assert.deepStrictEqual(d.calls, []);
});

test('copy：空串 / 非字符串 ⇒ failed（⛔ 往剪贴板写一个空串）', async function () {
  const r = recordingWin();
  const copier = C.createCopier({
    win: r.win,
    doc: makeDoc().doc,
    env: { isSecureContext: true, hasClipboardWrite: true, hasExecCommand: false },
  });
  assert.deepStrictEqual(await copier.copy(''), { ok: false, reason: C.FAIL_FAILED });
  assert.deepStrictEqual(await copier.copy(null), { ok: false, reason: C.FAIL_FAILED });
  assert.deepStrictEqual(r.seen, []);
});

// ── 导出面（node / 浏览器两条路都要在） ─────────────────────────────

test('导出面：node 侧 `require` 拿到的是完整 api', function () {
  ['pickMode', 'probe', 'capabilities', 'createCopier', 'defaultCopier'].forEach(function (k) {
    assert.strictEqual(typeof C[k], 'function', '缺 ' + k);
  });
});
