// `bugs/0081`：探针假后端的**信封保真度**——`fake-tauri.js` 必须与
// `src-tauri/src/document/envelope.rs` 的 `SAMPLES` 表**同口径**。
//
// ⭐ 为什么值得一条常驻判据：假后端少了产品的一步（归一化），探针就会拿到
//    产品**永远看不到**的输入（CRLF / BOM 原文），于是把「空行凭空多出来」
//    「标题字号丢失」这类**探针自己造出来的**假象当成产品 bug。
//    ⇒ 判据直接抄 Rust 那张表的 7 行样本，⛔ 不另造一套"听起来合理"的期望。
//
// ⚠️ 只走假后端的**公开面**（`window.__TAURI__.core.invoke`），⛔ 不去 require 内部函数：
//    把 `信封` / `收敛行尾` 导出来测试，等于给探针开第二个入口，而**产品路径用的是第一个**。
// ⚠️ 文件名**故意不带** `live-` 前缀：`make typecheck` 的 include 是 `tests/js/live-*.test.js`，
//    这一份不需要进那套 JSDoc 闸门。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const FAKE = path.join(ROOT, 'tools', 'live-probe', 'fake-tauri.js');
const BOM = '﻿';

/**
 * `envelope.rs` 测试模块里 `SAMPLES` 的逐行副本（2026-11-04 对过源码）。
 * `restorable` 的期望与 Rust 侧同义：`Other` **不**可逐字节还原。
 */
const SAMPLES = [
  { name: 'lf', body: 'a\nb\n', bom: false, eol: 'lf', restorable: true },
  { name: 'crlf', body: 'a\r\nb\r\n', bom: false, eol: 'crlf', restorable: true },
  { name: 'bom+crlf', body: 'a\r\nb\r\n', bom: true, eol: 'crlf', restorable: true },
  { name: 'no-trailing-newline', body: '# 标题\n正文', bom: false, eol: 'lf', restorable: true },
  { name: 'empty', body: '', bom: false, eol: 'lf', restorable: true },
  { name: 'mixed', body: 'a\r\nb\nc', bom: false, eol: 'other', restorable: false },
  { name: 'bare-cr', body: 'a\rb', bom: false, eol: 'other', restorable: false },
];

/**
 * 在**独立的 `vm` 上下文**里加载假后端：它是个 IIFE，靠 `window` 拿夹具，
 * 每个样本都要一份干净的 `window`（上一份的 `D.text` 会跟着保存前进）。
 */
function 装一页(text) {
  const D = {
    name: 'sample',
    text: text,
    html: '',
    blocks: [[0, 1, 1, 1]],
    block_kinds: ['Paragraph'],
    line_count: 2,
    toc: [],
  };
  const ctx = { window: {}, console: console };
  ctx.window.__FIXTURE = D;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(FAKE, 'utf8'), ctx, { filename: FAKE });
  if (!ctx.window.__TAURI__) {
    throw new Error('假后端没装起来：' + JSON.stringify(ctx.window.__FAKE));
  }
  return { inv: ctx.window.__TAURI__.core.invoke, D: D };
}

test('`bugs/0081`：假后端的信封与 `envelope.rs` 的 7 份样本逐项吻合', async function () {
  for (let i = 0; i < SAMPLES.length; i++) {
    const s = SAMPLES[i];
    const raw = (s.bom ? BOM : '') + s.body;
    const page = 装一页(raw);
    const be = await page.inv('begin_edit', {});
    const 期望缓冲 = s.body.replace(/\r\n?/g, '\n'); // Rust `to_lf`：`\r\n` 与裸 `\r` 都收敛

    // ① 编辑缓冲恒 LF、无 BOM（产品侧 `normalize_bytes` 的契约）
    assert.strictEqual(be.text, 期望缓冲, s.name + '：编辑缓冲必须是归一化后的那一份');
    assert.ok(be.text.indexOf('\r') < 0, s.name + '：缓冲里不许留任何 `\\r`');
    // ② `envelope` 由**磁盘原文**判定
    assert.strictEqual(be.envelope.eol, s.eol, s.name + '：行尾判定');
    assert.strictEqual(be.envelope.bom, s.bom, s.name + '：BOM 判定');
    assert.strictEqual(be.envelope.lossy, s.eol === 'other', s.name + '：`lossy` 只认 `other`');

    // ③ `Eol::Other` ⇒ 整篇不可编辑（`blocks.rs::to_wire` 的那一道）。
    //    ⚠️ 必须问在**保存之前**：落盘之后 `Other` 会变成 LF（产品同样如此）。
    const payload = await page.inv('open_document', { generation: 1, req: 1 });
    const 可编辑 = payload.blocks.map(function (b) { return b[3]; });
    if (s.eol === 'other') {
      assert.ok(可编辑.every(function (x) { return x === 0; }), s.name + '：整篇 editable=false');
    } else {
      assert.ok(可编辑.indexOf(1) >= 0, s.name + '：非 `other` 的文档仍可编辑');
    }

    // ④ 保存写回的是**磁盘形态**（`Envelope::restore`）：能还原的逐字相等，`Other` 统一 LF
    await page.inv('save_document', { text: be.text });
    assert.strictEqual(
      page.D.text,
      s.restorable ? raw : 期望缓冲,
      s.name + '：保存后的磁盘内容'
    );
  }
});

test('`bugs/0081`：这三条若是"直接回原文"的老写法，都会红（负对照）', async function () {
  // ⚠️ 不用改文件做变异（`tests.md` 要的变异已在实现期跑过），这里钉的是**可观测差异**：
  //    老写法 `begin_edit` 直接回 `D.text`、`save_document` 直接存前端缓冲 ⇒ 这三条必红。
  const crlf = 装一页('a\r\nb\r\n');
  const be = await crlf.inv('begin_edit', {});
  assert.notStrictEqual(be.text, crlf.D.text, 'CRLF 夹具：缓冲**不等于**磁盘原文（老的直接回原文会相等）');
  assert.match(be.text, /^a\nb\n$/, 'CRLF 夹具：缓冲是 LF');

  const bom = 装一页(BOM + 'a\n');
  const be2 = await bom.inv('begin_edit', {});
  assert.strictEqual(be2.text, 'a\n', 'BOM 夹具：首字符不被当成正文');
  assert.strictEqual(be2.envelope.bom, true, 'BOM 夹具：信封如实说"有 BOM"');
  await bom.inv('save_document', { text: be2.text });
  assert.strictEqual(bom.D.text, BOM + 'a\n', 'BOM 夹具：保存后 BOM 回来（⛔ 不是被剥掉写盘）');

  const mixed = 装一页('a\r\nb\nc');
  const p = await mixed.inv('open_document', { generation: 1, req: 1 });
  assert.deepStrictEqual(
    p.blocks.map(function (b) { return b[3]; }),
    [0],
    '混合行尾：老写法（不压 editable）会留 1'
  );
});
