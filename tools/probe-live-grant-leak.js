#!/usr/bin/env node
// 探针：`begin()` 在 `prep` 期间被 `leave()` 打断 ⇒ **写授权没有还回去**。
//
// 出处：`docs/reviews/2026-10-29-前端编辑内核-长跑走查.md` 的 N3
//      ＋ `docs/reviews/2026-10-29-后端与安全面-长跑走查.md`（P3 阶段的复核）。
//
// 为什么是探针而不是 `tests/js/` 里的用例：
//   `make test-js` 必须全绿，而这条**今天就是红的**（缺陷在场）。
//   把缺陷写成"断言它存在"的用例，会让下一个修它的人被一个绿色闸门拦住
//   ——所以判据留在 `tools/`，⛔ 不进闸门。修好之后把这条挪进 `tests/js/live-controller.test.js`
//   并改成断言 `end_edit` 恰好一次（那时它才有资格当闸门）。
//
// ⚠️ 只依赖 `src/live/index.js` 与假 deps：不建窗口、不碰磁盘、不联网。
// 退出码：0 = 授权恰好还了一次（缺陷已修）；1 = 漏还（缺陷在场）；2 = 前置没造出来。

'use strict';

const path = require('node:path');
const C = require(path.join(__dirname, '..', 'src', 'live', 'index.js'));

/** 与 Rust `blocks.rs::KIND_NAMES` 同序。 */
const KINDS = [
  'Paragraph', 'Heading', 'CodeBlock', 'List', 'BlockQuote',
  'Table', 'HtmlBlock', 'ThematicBreak', 'FootnoteDefinition', 'Other',
];

const TEXT = 'A\n\nC';

function payloadFor(txt) {
  const n = txt.split('\n').length;
  return {
    real_path: '/tmp/a.md',
    gen: 7,
    doc_seq: 3,
    line_count: n,
    html: txt,
    toc: [],
    block_kinds: KINDS,
    blocks: [[0, 1, n, 1]],
  };
}

/**
 * 假 deps（覆盖点与 `tests/js/live-controller.test.js::harness` 同名同义）。
 * `gate` 用来把 `begin()` 卡在 `await d.beginEdit(...)` 里。
 */
function harness(gate) {
  const st = { begins: 0, ends: 0, mounts: 0, swaps: 0, payload: payloadFor(TEXT) };
  const ctrl = C.createController({
    t: function (k, v) { return v ? k + ' ' + JSON.stringify(v) : k; },
    report: function () {},
    announce: function () {},
    beginEdit: async function () {
      st.begins++;
      await gate;
      return { real_path: '/tmp/a.md', text: TEXT, envelope: { bom: false, eol: 'lf', lossy: false } };
    },
    endEdit: async function () { st.ends++; },
    renderPreview: async function (arg) { return payloadFor(arg.text); },
    mount: function (p) { st.mounts++; st.payload = p; ctrl.notePayload(p); },
    nodeOf: function (i) { return { index: i }; },
    saveDisk: async function () {},
    makeView: function (arg) {
      const lines = String(arg.text).split('\n');
      return {
        dom: { id: 'view' },
        lines: function () { return lines.slice(); },
        height: function () { return 100; },
        destroy: function () {},
        caret: function () { return 0; },
        focusAt: function () {},
      };
    },
    swap: function () { st.swaps++; return { undo: function () {} }; },
    heightOf: function () { return 100; },
    pendingHost: function () { return { pending: true }; },
  });
  ctrl.notePayload(st.payload);
  return { ctrl: ctrl, st: st };
}

async function run() {
  let release;
  const gate = new Promise(function (r) { release = r; });
  const h = harness(gate);

  const p = h.ctrl.begin({ index: 0, block: h.ctrl.blocks()[0], el: {} });
  // 让 `begin()` 走到 `await d.beginEdit(...)`（此间 `state === 'prep'`、`active === null`）。
  await new Promise(function (r) { setImmediate(r); });
  const mid = h.ctrl.state();

  // 此刻 `main.js` 的 Esc / 点走 / 外部改动会调 `live.leave()`。
  const left = await h.ctrl.leave({});
  release();
  const r = await p;

  console.log('prep 时 state        =', mid);
  console.log('leave() 返回         =', JSON.stringify(left));
  console.log('begin() 返回         =', JSON.stringify(r));
  console.log('最终 state           =', h.ctrl.state());
  console.log('begin_edit 调用次数  =', h.st.begins);
  console.log('end_edit 调用次数    =', h.st.ends, ' ← 期望 1（授过权就必须还）');
  console.log('swap 次数            =', h.st.swaps, ' ← 期望 0（被打断的一趟不许动 DOM）');

  const pre =
    mid === 'prep' &&
    left.ok === true &&
    r.ok === false && r.why === 'superseded' &&
    h.ctrl.state() === 'viewing' &&
    h.st.swaps === 0 &&
    h.st.begins === 1;
  if (!pre) {
    console.log('⛔ 前置不成立：没造出「prep 期间被 leave 打断」，本次结论无效');
    return 2;
  }
  if (h.st.ends === 1) {
    console.log('✅ 授权恰好还了一次');
    return 0;
  }
  console.log(
    '⛔ 漏还：`begin_edit` 授过权（' + h.st.begins + ' 次），`end_edit` 只调了 ' + h.st.ends + ' 次。\n' +
      '   路径：`begin()` 在 `prep` 期间 `await d.beginEdit`；`leave()` 的 `!active` 快路径\n' +
      '   （`src/live/index.js:1223-1226`）只把 `state` 改回 `viewing`，**不推进 `enterSeq`**、\n' +
      '   **不调 `safeEndEdit`**；`begin()` 醒来后 440 行的 `my !== enterSeq` 因而不成立，\n' +
      '   445 行直接 `return` ⇒ 授权留在后端（写授权没撤，`design/0012` 要求退出即撤）。'
  );
  return 1;
}

run().then(
  function (code) { process.exitCode = code; },
  function (e) { console.error('探针自身出错：', e); process.exitCode = 2; }
);
