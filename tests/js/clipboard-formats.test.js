// `design/0077`：多格式复制与字面粘贴的**纯逻辑**与**写入/读取通路**。
//
// ⚠️ 这一份**从不碰真剪贴板**：`win` / `doc` / `env` 全部是假的，
//    `ClipboardItem` / `Blob` / `write` / `execCommand` / `readText` 都只是记录调用的桩子。
//    ⭐ 这是硬约束——`make test-js` 会在**用户的真机上**跑。
//
// ⚠️ 这里钉的是四类**静默**错法：
//    ① MIME 集合/顺序写错（富文本少了 `text/plain` 兜底、HTML 源码误写 `text/html`）；
//    ② 块边界差一行（1-based 闭区间），界面上一切正常；
//    ③ 没有源码时假装有（阅读态从前端 HTML 反推 Markdown = 第二套正文真相）；
//    ④ 失败后偷偷降级成别的格式或先报「已复制」。

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const F = require('../../src/services/copyformats.js');
const C = require('../../src/services/clipboard.js');

// ── 夹具 ─────────────────────────────────────────────────────────────

function entry(mime, text) {
  return { mime: mime, text: text };
}

/** 假 `window`：标准 `navigator.clipboard.write` 那条路。 */
function makeClipWin(opts) {
  const o = opts || {};
  const writes = [];
  const blobs = [];
  const items = [];

  function FakeBlob(parts, options) {
    this.parts = parts;
    this.type = options && options.type;
    blobs.push(this);
  }
  function FakeClipboardItem(parts) {
    if (o.ctorThrows) throw new Error('mime rejected');
    this.parts = parts;
    items.push(this);
  }

  const clipboard = {
    write: function (list) {
      writes.push(list);
      if (o.writeError) return Promise.reject(o.writeError);
      if (o.writePending) return o.writePending;
      return Promise.resolve();
    },
  };
  if (o.readText) clipboard.readText = o.readText;

  return {
    win: {
      isSecureContext: true,
      Blob: FakeBlob,
      ClipboardItem: FakeClipboardItem,
      navigator: { clipboard: clipboard },
    },
    writes: writes,
    blobs: blobs,
    items: items,
  };
}

/**
 * 假 `document`：`execCommand('copy')` 那条路。
 * `fireCopy` 为真时，在 `execCommand` 里同步派发一次 `copy` 事件（真实浏览器就是这样）。
 */
function makeExecDoc(opts) {
  const o = opts || {};
  const listeners = {};
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
    activeElement: o.activeElement === undefined ? active : o.activeElement,
    body: body,
    seen: null,
    createElement: function (tag) { calls.push('createElement:' + tag); return ta; },
    addEventListener: function (type, fn, capture) {
      listeners[type] = { fn: fn, capture: capture };
      calls.push('add-listener:' + type);
    },
    removeEventListener: function (type, fn) {
      if (listeners[type] && listeners[type].fn === fn) delete listeners[type];
      calls.push('remove-listener:' + type);
    },
    execCommand: function (cmd) {
      calls.push('exec:' + cmd);
      if (o.execThrows) throw new Error('boom');
      const l = listeners.copy;
      if (l && o.fireCopy) {
        const seen = {};
        const ev = {
          preventDefault: function () { calls.push('preventDefault'); },
          clipboardData: {
            setData: function (mime, text) {
              if (o.throwMime === mime) throw new Error('mime rejected');
              seen[mime] = text;
            },
          },
        };
        l.fn(ev);
        doc.seen = seen;
      }
      return o.execResult === undefined ? true : o.execResult;
    },
  };
  return { doc: doc, ta: ta, active: active, calls: calls, listeners: listeners };
}

const ENV_CLIP = {
  isSecureContext: true,
  hasClipboardWriteAll: true,
  hasClipboardItem: true,
  hasBlob: true,
  hasExecCommand: false,
};
const ENV_EXEC = {
  isSecureContext: false,
  hasClipboardWriteAll: false,
  hasClipboardItem: false,
  hasBlob: false,
  hasExecCommand: true,
};
const ENV_NONE = {
  isSecureContext: false,
  hasClipboardWriteAll: false,
  hasClipboardItem: false,
  hasBlob: false,
  hasExecCommand: false,
};

function clipboardCopier(win) {
  return C.createFormatCopier({ win: win, doc: null, env: ENV_CLIP });
}
function execCopier(doc, win) {
  return C.createFormatCopier({ win: win || { isSecureContext: false, navigator: {} }, doc: doc, env: ENV_EXEC });
}

// ── ① MIME 计划（`INV-CLIPFMT-01`） ─────────────────────────────────

test('writeEntries：Markdown / 纯文本都写 text/plain，正文逐字（只统一行尾）', function () {
  assert.deepStrictEqual(F.writeEntries(F.KIND_MARKDOWN, { text: '# 标题\n\n正文' }), [
    entry('text/plain', '# 标题\n\n正文'),
  ]);
  assert.deepStrictEqual(F.writeEntries(F.KIND_PLAIN, { text: '**不是富文本**' }), [
    entry('text/plain', '**不是富文本**'),
  ]);
  // ⚠️ 行尾统一 LF（`INV-EDIT-12`），其余一个字节都不动
  assert.deepStrictEqual(F.writeEntries(F.KIND_MARKDOWN, { text: 'a\r\nb\rc' }), [
    entry('text/plain', 'a\nb\nc'),
  ]);
});

test('writeEntries：HTML **源码**写 text/plain（⛔ 不是 text/html）', function () {
  assert.deepStrictEqual(F.writeEntries(F.KIND_HTML, { html: '<p>a</p>' }), [
    entry('text/plain', '<p>a</p>'),
  ]);
  // 源码动作只看 `html` 字段：`text` 有内容也不能冒充
  assert.strictEqual(F.writeEntries(F.KIND_HTML, { text: 'a', html: '' }), null);
});

test('writeEntries：富文本是 text/html ＋ text/plain 兜底，顺序不能反', function () {
  const out = F.writeEntries(F.KIND_RICH, { html: '<p><b>a</b></p>', text: 'a' });
  assert.deepStrictEqual(out, [
    entry('text/html', '<p><b>a</b></p>'),
    entry('text/plain', 'a'),
  ]);
  // ⚠️ 没有可见文字时兜底是空串，但**条目必须在**（少了它，纯文本框粘出来是空白 + 粘贴菜单禁用）
  assert.deepStrictEqual(F.writeEntries(F.KIND_RICH, { html: '<img src="x">' }), [
    entry('text/html', '<img src="x">'),
    entry('text/plain', ''),
  ]);
});

test('writeEntries：缺必需内容 ⇒ null（⛔ 不降级成别的格式），未知种类 ⇒ null', function () {
  assert.strictEqual(F.writeEntries(F.KIND_MARKDOWN, {}), null);
  assert.strictEqual(F.writeEntries(F.KIND_MARKDOWN, { text: '' }), null);
  assert.strictEqual(F.writeEntries(F.KIND_PLAIN, null), null);
  assert.strictEqual(F.writeEntries(F.KIND_HTML, {}), null);
  assert.strictEqual(F.writeEntries(F.KIND_RICH, {}), null);
  assert.strictEqual(F.writeEntries(F.KIND_RICH, { text: 'a' }), null);
  assert.strictEqual(F.writeEntries('rtf', { html: '<p>a</p>', text: 'a' }), null);
});

test('normalizeNewlines：非字符串 ⇒ 空串；CRLF/CR ⇒ LF', function () {
  assert.strictEqual(F.normalizeNewlines('a\r\nb\rc'), 'a\nb\nc');
  assert.strictEqual(F.normalizeNewlines('a\nb'), 'a\nb');
  assert.strictEqual(F.normalizeNewlines(null), '');
  assert.strictEqual(F.normalizeNewlines(42), '');
});

// ── ② 选区片段 ─────────────────────────────────────────────────────

test('selectionSnippet：空白也是用户选中的内容，只有空串算"没选"', function () {
  assert.strictEqual(F.selectionSnippet('  a\n b  '), '  a\n b  ');
  assert.strictEqual(F.selectionSnippet('a\r\nb'), 'a\nb');
  assert.strictEqual(F.selectionSnippet(''), null);
  assert.strictEqual(F.selectionSnippet('   '), '   ');
  assert.strictEqual(F.selectionSnippet(null), null);
});

test('sourceSnippet：1-based 闭区间、跨块取并集、反向参数自动换位', function () {
  const full = '# A\npara a\n\n## B\npara b\n\nend';
  const blocks = [
    { index: 1, startLine: 1, endLine: 3 },
    { index: 2, startLine: 4, endLine: 5 },
    { index: 3, startLine: 7, endLine: 7 },
  ];
  assert.deepStrictEqual(F.sourceSnippet(full, blocks, 1, 1), {
    text: '# A\npara a\n',
    startLine: 1,
    endLine: 3,
  });
  assert.deepStrictEqual(F.sourceSnippet(full, blocks, 1, 2), {
    text: '# A\npara a\n\n## B\npara b',
    startLine: 1,
    endLine: 5,
  });
  // 反向给参数（选区 anchor 在 head 之后）与正向完全一致
  assert.deepStrictEqual(F.sourceSnippet(full, blocks, 2, 1), {
    text: '# A\npara a\n\n## B\npara b',
    startLine: 1,
    endLine: 5,
  });
  assert.deepStrictEqual(F.sourceSnippet(full, blocks, 3, 3), {
    text: 'end',
    startLine: 7,
    endLine: 7,
  });
});

test('sourceSnippet：缩进与行内空白逐字保留', function () {
  const full = 'text\n    indented code\n\tTab';
  const blocks = [{ index: 1, startLine: 2, endLine: 3 }];
  assert.strictEqual(F.sourceSnippet(full, blocks, 1, 1).text, '    indented code\n\tTab');
});

test('sourceSnippet：边界拒绝（未知块 / 非整数 / 越界 / 空文本 / 坏块表）', function () {
  const full = 'a\nb\nc';
  const blocks = [{ index: 1, startLine: 1, endLine: 1 }];
  assert.strictEqual(F.sourceSnippet(full, blocks, 9, 9), null, '未知块序号');
  assert.strictEqual(F.sourceSnippet(full, blocks, 1.5, 1), null, '非整数');
  assert.strictEqual(F.sourceSnippet(full, blocks, '1', 1), null, '字符串不是序号');
  assert.strictEqual(F.sourceSnippet('', blocks, 1, 1), null, '空全文');
  assert.strictEqual(F.sourceSnippet(full, null, 1, 1), null, '没有块表');
  assert.strictEqual(F.sourceSnippet(full, [], 1, 1), null, '空块表');
  assert.strictEqual(F.sourceSnippet(full, [{ index: 1, startLine: 1, endLine: 99 }], 1, 1), null, '越过末行');
  assert.strictEqual(F.sourceSnippet(full, [{ index: 1, startLine: 0, endLine: 1 }], 1, 1), null, '0 行不存在');
  assert.strictEqual(F.sourceSnippet(full, [{ index: 1, startLine: 2, endLine: 1 }], 1, 1), null, '倒置区间');
  // ⚠️ 纯空行不算内容（Markdown 块表不会给出这种块）
  assert.strictEqual(F.sourceSnippet('a\n\nc', [{ index: 1, startLine: 2, endLine: 2 }], 1, 1), null);
});

test('sourceSnippet：CRLF 全文先统一成 LF 再切行', function () {
  const full = 'a\r\nb\r\nc';
  const blocks = [{ index: 1, startLine: 1, endLine: 2 }];
  assert.deepStrictEqual(F.sourceSnippet(full, blocks, 1, 1), {
    text: 'a\nb',
    startLine: 1,
    endLine: 2,
  });
});

// ── ③ 语境判据矩阵 ─────────────────────────────────────────────────

test('checkCopy：四种格式 × 三种语境 × 有无选区/源码', function () {
  const kinds = [F.KIND_MARKDOWN, F.KIND_HTML, F.KIND_PLAIN, F.KIND_RICH];

  kinds.forEach(function (kind) {
    assert.strictEqual(F.checkCopy(kind, 'none', true, true), 'no-document');
    assert.strictEqual(F.checkCopy(kind, 'split', false, true), 'no-selection');
    assert.strictEqual(F.checkCopy(kind, 'live', false, true), 'no-selection');
    assert.strictEqual(F.checkCopy(kind, 'reading', false, true), 'no-selection');
    assert.strictEqual(F.checkCopy(kind, 'split', true, false), 'ok');
    assert.strictEqual(F.checkCopy(kind, 'live', true, false), 'ok');
  });

  // ⭐ 只有「阅读态 + Markdown」需要会话源码
  assert.strictEqual(F.checkCopy(F.KIND_MARKDOWN, 'reading', true, false), 'no-source');
  assert.strictEqual(F.checkCopy(F.KIND_MARKDOWN, 'reading', true, true), 'ok');
  assert.strictEqual(F.checkCopy(F.KIND_HTML, 'reading', true, false), 'ok');
  assert.strictEqual(F.checkCopy(F.KIND_PLAIN, 'reading', true, false), 'ok');
  assert.strictEqual(F.checkCopy(F.KIND_RICH, 'reading', true, false), 'ok');
  // ⚠️ 没有选区优先于没有源码
  assert.strictEqual(F.checkCopy(F.KIND_MARKDOWN, 'reading', false, false), 'no-selection');

  assert.strictEqual(F.checkCopy('rtf', 'split', true, true), 'unsupported');
  assert.strictEqual(F.checkCopy(F.KIND_MARKDOWN, 'bogus-mode', true, true), 'no-document');
});

// ── ④ 渲染 HTML → 可见文字（只用于纯文本/富文本兜底） ──────────────

test('htmlToText：无 DOM 时走可预测的兜底（块换行、去脚本、解实体）', function () {
  assert.strictEqual(F.htmlToText('<p>a</p><p>b</p>'), 'a\nb');
  assert.strictEqual(F.htmlToText('<div><p>x</p></div>'), 'x');
  assert.strictEqual(F.htmlToText('a<br>b'), 'a\nb');
  assert.strictEqual(F.htmlToText('<p>a &amp; b &lt;c&gt;</p>'), 'a & b <c>');
  assert.strictEqual(F.htmlToText('<script>alert(1)</script><p>ok</p>'), 'ok');
  assert.strictEqual(F.htmlToText('<style>p{}</style><p>ok</p>'), 'ok');
  assert.strictEqual(F.htmlToText(''), '');
  assert.strictEqual(F.htmlToText(null), '');
});

test('htmlToText：假 DOM 没有 innerHTML 面 / 建文档抛错 ⇒ 仍走兜底，⛔ 不抛给调用方', function () {
  const fakeDoc = { createElement: function () { return {}; } };
  assert.strictEqual(F.htmlToText('<p>a</p><p>b</p>', fakeDoc), 'a\nb');
  const throwingDoc = {
    createElement: function () { throw new Error('boom'); },
  };
  assert.strictEqual(F.htmlToText('<p>a</p>', throwingDoc), 'a');
  const throwingImpl = {
    implementation: { createHTMLDocument: function () { throw new Error('boom'); } },
  };
  assert.strictEqual(F.htmlToText('<p>a</p>', throwingImpl), 'a');
});

// ── ⑤ 能力探针与模式选择 ───────────────────────────────────────────

test('probeFormats：只读——⛔ 不调 write / readText / execCommand / ClipboardItem 构造', function () {
  const calls = [];
  const win = {
    isSecureContext: true,
    ClipboardItem: function () { calls.push('ClipboardItem'); },
    Blob: function () { calls.push('Blob'); },
    navigator: {
      clipboard: {
        write: function () { calls.push('write'); return Promise.resolve(); },
        readText: function () { calls.push('readText'); return Promise.resolve(''); },
      },
    },
  };
  const doc = { execCommand: function () { calls.push('execCommand'); return true; } };
  assert.deepStrictEqual(C.probeFormats(win, doc), {
    isSecureContext: true,
    hasClipboardWriteAll: true,
    hasClipboardItem: true,
    hasBlob: true,
    hasReadText: true,
    hasExecCommand: true,
  });
  assert.deepStrictEqual(calls, [], '⚠️ 探针一旦真写一次，用户的剪贴板就被覆盖了');
});

test('probeFormats：环境缺东西时逐项为假（⛔ 不抛）', function () {
  const env = C.probeFormats({}, {});
  assert.strictEqual(env.isSecureContext, false);
  assert.strictEqual(env.hasClipboardWriteAll, false);
  assert.strictEqual(env.hasClipboardItem, false);
  assert.strictEqual(env.hasReadText, false);
  assert.strictEqual(env.hasExecCommand, false);
});

test('pickFormatMode：标准 API 要四件齐（secure ＋ write ＋ ClipboardItem ＋ Blob）', function () {
  assert.strictEqual(C.pickFormatMode(ENV_CLIP), C.MODE_CLIPBOARD);
  assert.strictEqual(C.pickFormatMode({
    isSecureContext: true, hasClipboardWriteAll: true, hasClipboardItem: false,
    hasBlob: true, hasExecCommand: true,
  }), C.MODE_EXEC, '缺 ClipboardItem ⇒ 不是标准 API，退到 exec（开跑前选定）');
  assert.strictEqual(C.pickFormatMode({
    isSecureContext: true, hasClipboardWriteAll: true, hasClipboardItem: true,
    hasBlob: false, hasExecCommand: true,
  }), C.MODE_EXEC, '缺 Blob ⇒ 造不出 ClipboardItem');
  assert.strictEqual(C.pickFormatMode({
    isSecureContext: false, hasClipboardWriteAll: true, hasClipboardItem: true,
    hasBlob: true, hasExecCommand: true,
  }), C.MODE_EXEC, '非 secure context');
  assert.strictEqual(C.pickFormatMode(ENV_NONE), C.MODE_NONE);
  assert.strictEqual(C.pickFormatMode(), C.MODE_NONE);
  // ⚠️ 严格 `=== true`：字符串真值不算
  assert.strictEqual(C.pickFormatMode({
    isSecureContext: 'true', hasClipboardWriteAll: true, hasClipboardItem: true,
    hasBlob: true, hasExecCommand: false,
  }), C.MODE_NONE);
});

// ── ⑥ 标准 API 写入 ────────────────────────────────────────────────

test('write（clipboard）：一个 ClipboardItem 装全部 MIME，Blob 的 type 与正文都对', async function () {
  const w = makeClipWin();
  const copier = clipboardCopier(w.win);
  assert.strictEqual(copier.mode, C.MODE_CLIPBOARD);

  const out = await copier.write(F.writeEntries(F.KIND_RICH, {
    html: '<p><b>a</b></p>',
    text: 'a',
  }));
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(w.writes.length, 1);
  assert.strictEqual(w.writes[0].length, 1, '只写一个 ClipboardItem');
  assert.strictEqual(w.items.length, 1);
  const parts = w.items[0].parts;
  assert.deepStrictEqual(Object.keys(parts).sort(), ['text/html', 'text/plain']);
  assert.deepStrictEqual(parts['text/html'].parts, ['<p><b>a</b></p>']);
  assert.strictEqual(parts['text/html'].type, 'text/html');
  assert.deepStrictEqual(parts['text/plain'].parts, ['a']);
  assert.strictEqual(parts['text/plain'].type, 'text/plain');
});

test('write（clipboard）：⚠️ 等到 write() 真完成才报成功', async function () {
  let resolveWrite;
  const pending = new Promise(function (res) { resolveWrite = res; });
  const w = makeClipWin({ writePending: pending });
  const copier = clipboardCopier(w.win);
  let settled = null;
  const p = copier.write(F.writeEntries(F.KIND_MARKDOWN, { text: '# a' }))
    .then(function (v) { settled = v; return v; });
  await Promise.resolve();
  assert.strictEqual(settled, null, '⚠️ 写还没完成就说成功 ⇒ 用户粘出来是旧内容');
  resolveWrite();
  assert.deepStrictEqual(await p, { ok: true });
});

test('write（clipboard）：NotAllowedError ⇒ denied；别的错误 ⇒ failed（⛔ 不换 exec）', async function () {
  const denied = new Error('denied');
  denied.name = 'NotAllowedError';
  const w1 = makeClipWin({ writeError: denied });
  assert.deepStrictEqual(
    await clipboardCopier(w1.win).write(F.writeEntries(F.KIND_PLAIN, { text: 'a' })),
    { ok: false, reason: C.FAIL_DENIED }
  );

  const w2 = makeClipWin({ writeError: new Error('boom') });
  assert.deepStrictEqual(
    await clipboardCopier(w2.win).write(F.writeEntries(F.KIND_PLAIN, { text: 'a' })),
    { ok: false, reason: C.FAIL_FAILED }
  );
});

test('write（clipboard）：平台拒绝某个 MIME（构造 ClipboardItem 抛）⇒ unsupported，⛔ 不偷偷只写 text/plain', async function () {
  const w = makeClipWin({ ctorThrows: true });
  const out = await clipboardCopier(w.win).write(
    F.writeEntries(F.KIND_RICH, { html: '<p>a</p>', text: 'a' })
  );
  assert.deepStrictEqual(out, { ok: false, reason: C.FAIL_UNSUPPORTED });
  assert.strictEqual(w.writes.length, 0, '⛔ 不许降级成纯文本后报「已复制」');
});

test('write：空条目 / 坏形状 ⇒ failed，且一次也不碰 clipboard', async function () {
  const w = makeClipWin();
  const copier = clipboardCopier(w.win);
  assert.deepStrictEqual(await copier.write([]), { ok: false, reason: C.FAIL_FAILED });
  assert.deepStrictEqual(await copier.write(null), { ok: false, reason: C.FAIL_FAILED });
  assert.deepStrictEqual(await copier.write([{ mime: '', text: 'a' }]), { ok: false, reason: C.FAIL_FAILED });
  assert.deepStrictEqual(await copier.write([{ mime: 'text/plain', text: 1 }]), { ok: false, reason: C.FAIL_FAILED });
  assert.strictEqual(w.writes.length, 0);
});

test('write（none）：能力缺失 ⇒ unsupported，且⛔ 不碰 DOM', async function () {
  const d = makeExecDoc();
  const copier = C.createFormatCopier({
    win: { isSecureContext: false, navigator: {} },
    doc: d.doc,
    env: ENV_NONE,
  });
  assert.strictEqual(copier.mode, C.MODE_NONE);
  assert.deepStrictEqual(
    await copier.write(F.writeEntries(F.KIND_MARKDOWN, { text: '# a' })),
    { ok: false, reason: C.FAIL_UNSUPPORTED }
  );
  assert.deepStrictEqual(d.calls, []);
});

// ── ⑦ execCommand 写入 ─────────────────────────────────────────────

test('write（exec）：纯文本一次成功，临时节点清掉、监听摘掉、焦点还回去', async function () {
  const d = makeExecDoc();
  const copier = execCopier(d.doc);
  assert.strictEqual(copier.mode, C.MODE_EXEC);

  const out = await copier.write(F.writeEntries(F.KIND_MARKDOWN, { text: '# 标题' }));
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(d.ta.value, '# 标题', '选区内容来自 textarea 的**值**');
  assert.strictEqual(d.ta.parentNode, null, '临时 textarea 必须被移除');
  assert.strictEqual(d.active.focusCount, 1, '⚠️ 复制一下不许把用户正在打字的焦点抢走');
  assert.strictEqual(d.listeners.copy, undefined, 'copy 监听必须摘掉（⛔ 留在 document 上会吃掉下一次复制）');
  assert.ok(d.calls.indexOf('add-listener:copy') >= 0);
  assert.ok(d.calls.indexOf('preventDefault') < 0, '纯文本不需要改浏览器默认');
});

test('write（exec）：富文本在 copy 事件里写入两个 MIME（顺序与正文都对）', async function () {
  const d = makeExecDoc({ fireCopy: true });
  const copier = execCopier(d.doc);
  const out = await copier.write(F.writeEntries(F.KIND_RICH, {
    html: '<p>a</p>',
    text: 'a',
  }));
  assert.deepStrictEqual(out, { ok: true });
  assert.deepStrictEqual(d.doc.seen, { 'text/html': '<p>a</p>', 'text/plain': 'a' });
  assert.ok(d.calls.indexOf('preventDefault') >= 0);
  assert.strictEqual(d.listeners.copy, undefined);
  assert.strictEqual(d.active.focusCount, 1);
});

test('write（exec）：⚠️ 需要自定义 MIME 却没拿到 copy 事件 ⇒ failed（⛔ 冒充成功）', async function () {
  const d = makeExecDoc({ fireCopy: false });
  const copier = execCopier(d.doc);
  const out = await copier.write(F.writeEntries(F.KIND_RICH, {
    html: '<p>a</p>',
    text: 'a',
  }));
  assert.deepStrictEqual(out, { ok: false, reason: C.FAIL_FAILED });
  assert.strictEqual(d.ta.parentNode, null, '失败也要清理');
  assert.strictEqual(d.active.focusCount, 1, '失败也要还焦点');
});

test('write（exec）：setData 抛（平台不认某个 MIME）⇒ failed', async function () {
  const d = makeExecDoc({ fireCopy: true, throwMime: 'text/html' });
  const copier = execCopier(d.doc);
  const out = await copier.write(F.writeEntries(F.KIND_RICH, {
    html: '<p>a</p>',
    text: 'a',
  }));
  assert.deepStrictEqual(out, { ok: false, reason: C.FAIL_FAILED });
});

test('write（exec）：execCommand 返回 false / 抛 ⇒ failed，且照样清理 + 还焦点', async function () {
  const d1 = makeExecDoc({ execResult: false });
  assert.deepStrictEqual(
    await execCopier(d1.doc).write(F.writeEntries(F.KIND_PLAIN, { text: 'a' })),
    { ok: false, reason: C.FAIL_FAILED }
  );
  assert.strictEqual(d1.active.focusCount, 1);

  const d2 = makeExecDoc({ execThrows: true });
  assert.deepStrictEqual(
    await execCopier(d2.doc).write(F.writeEntries(F.KIND_PLAIN, { text: 'a' })),
    { ok: false, reason: C.FAIL_FAILED }
  );
  assert.strictEqual(d2.ta.parentNode, null);
  assert.strictEqual(d2.active.focusCount, 1);
  assert.strictEqual(d2.listeners.copy, undefined);
});

test('write（exec）：没有原来的焦点 ⇒ 不抛', async function () {
  const d = makeExecDoc({ activeElement: null });
  assert.deepStrictEqual(
    await execCopier(d.doc).write(F.writeEntries(F.KIND_PLAIN, { text: 'a' })),
    { ok: true }
  );
});

test('write（exec）：document 没有监听面 ⇒ unsupported（⛔ 静默什么都不做）', async function () {
  const d = makeExecDoc();
  delete d.doc.addEventListener;
  assert.deepStrictEqual(
    await execCopier(d.doc).write(F.writeEntries(F.KIND_PLAIN, { text: 'a' })),
    { ok: false, reason: C.FAIL_UNSUPPORTED }
  );
  assert.deepStrictEqual(d.calls, []);
});

// ── ⑧ 读取（字面粘贴只读 text/plain） ──────────────────────────────

test('read：成功 ⇒ 原样返回文本；非字符串 ⇒ 空串', async function () {
  const win = {
    navigator: {
      clipboard: {
        write: function () { return Promise.resolve(); },
        readText: function () { return Promise.resolve('  # 原样\n\t片段  '); },
      },
    },
  };
  const copier = clipboardCopier(win);
  assert.deepStrictEqual(await copier.read(), { ok: true, text: '  # 原样\n\t片段  ' });

  const win2 = {
    navigator: {
      clipboard: {
        write: function () { return Promise.resolve(); },
        readText: function () { return Promise.resolve(null); },
      },
    },
  };
  assert.deepStrictEqual(await clipboardCopier(win2).read(), { ok: true, text: '' });
});

test('read：NotAllowedError ⇒ denied；别的错误 ⇒ failed；没有 API ⇒ unsupported', async function () {
  function winWith(readText) {
    return {
      navigator: {
        clipboard: {
          write: function () { return Promise.resolve(); },
          readText: readText,
        },
      },
    };
  }
  const denied = new Error('denied');
  denied.name = 'NotAllowedError';
  assert.deepStrictEqual(
    await clipboardCopier(winWith(function () { return Promise.reject(denied); })).read(),
    { ok: false, reason: C.FAIL_DENIED }
  );
  assert.deepStrictEqual(
    await clipboardCopier(winWith(function () { return Promise.reject(new Error('boom')); })).read(),
    { ok: false, reason: C.FAIL_FAILED }
  );
  assert.deepStrictEqual(
    await clipboardCopier({ navigator: { clipboard: { write: function () { return Promise.resolve(); } } } }).read(),
    { ok: false, reason: C.FAIL_UNSUPPORTED }
  );
  assert.deepStrictEqual(await clipboardCopier({}).read(), { ok: false, reason: C.FAIL_UNSUPPORTED });
});

test('read：只调 readText，⛔ 不顺手写剪贴板', async function () {
  const calls = [];
  const win = {
    navigator: {
      clipboard: {
        write: function () { calls.push('write'); return Promise.resolve(); },
        readText: function () { calls.push('readText'); return Promise.resolve('a'); },
      },
    },
  };
  await clipboardCopier(win).read();
  assert.deepStrictEqual(calls, ['readText']);
});

// ── ⑨ 导出面 ──────────────────────────────────────────────────────

test('导出面：copyformats 与 clipboard 的新函数都在', function () {
  ['writeEntries', 'selectionSnippet', 'sourceSnippet', 'checkCopy', 'htmlToText', 'normalizeNewlines']
    .forEach(function (k) { assert.strictEqual(typeof F[k], 'function', 'copyformats 缺 ' + k); });
  ['probeFormats', 'pickFormatMode', 'createFormatCopier', 'defaultFormatCopier']
    .forEach(function (k) { assert.strictEqual(typeof C[k], 'function', 'clipboard 缺 ' + k); });
  // ⚠️ 既有面一个字不变（`INV-CLIPFMT-02`）
  ['pickMode', 'probe', 'capabilities', 'createCopier', 'defaultCopier']
    .forEach(function (k) { assert.strictEqual(typeof C[k], 'function', 'clipboard 丢了 ' + k); });
});
