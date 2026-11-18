// 控制器装配：纯换算、身份四件套、进入 / 提交 / 保存 / 撤销 / 打勾 / 重置的顺序与失败保留。
// 守的是 `INV-LIVE-06/17/20`、`INV-TASK-03/04/06` 与「提交失败不许销毁视图」。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

const DEPS = ['model', 'blocks', 'cell', 'task', 'objects', 'txn'];

function loadIndex() {
  const win = {};
  for (const name of DEPS) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'live', name + '.js'), 'utf8');
    new Function('window', src)(win);
  }
  const src = fs.readFileSync(path.join(ROOT, 'src', 'live', 'index.js'), 'utf8');
  new Function('window', src)(win);
  return win.rmd;
}

const R = loadIndex();
const LC = R.liveController;
const M = R.liveModel;

function payload(over) {
  const p = {
    real_path: '/a.md',
    generation: 1,
    doc_seq: 1,
    line_count: 2,
    block_kinds: ['Paragraph'],
    blocks: [[0, 1, 2, 1]],
    table_cells: [],
    task_items: [],
  };
  return Object.assign(p, over || {});
}

function view(lines) {
  const v = {
    rows: lines.slice(),
    height: function () {
      return v.want;
    },
    want: 20,
    destroyed: 0,
    focus: null,
    lines: function () {
      return v.rows.slice();
    },
    destroy: function () {
      v.destroyed++;
    },
    focusAt: function (p) {
      v.focus = p;
    },
    selection: function () {
      return v.sel || { anchor: 0, head: 0 };
    },
    caret: function () {
      return 0;
    },
  };
  return v;
}

function harness(over) {
  const o = over || {};
  const reports = [];
  const announces = [];
  const v = o.view || view(o.viewLines || ['- a', '- b']);
  const deps = Object.assign({
    t: function (k, p) {
      return p === undefined ? k : k + '(' + JSON.stringify(p) + ')';
    },
    report: function (m, err) {
      reports.push({ m: m, err: err });
    },
    announce: function (m) {
      announces.push(m);
    },
    beginEdit: async function () {
      return o.grant || { real_path: '/a.md', text: '- a\n- b', envelope: { eol: 'lf' } };
    },
    endEdit: async function (x) {
      (o.endEditCalls || (o.endEditCalls = [])).push(x);
    },
    renderPreview: async function (req) {
      if (o.preview) return o.preview(req);
      const n = req.text.split('\n').length;
      return payload({ line_count: n, blocks: [[0, 1, n, 1]], commit_seq: 99 });
    },
    mount: function () {
      o.mountCalls = (o.mountCalls || 0) + 1;
      if (o.mountThrows) throw new Error('mount-boom');
    },
    saveDisk: async function (p) {
      (o.saves || (o.saves = [])).push(p);
    },
    makeView: function (opts) {
      o.viewOpts = opts;
      return v;
    },
    swap: function () {
      return {
        undo: function () {
          o.swapUndos = (o.swapUndos || 0) + 1;
        },
      };
    },
    nodeOf: function () {
      return { node: true };
    },
    cellNodeOf: function () {
      return { cell: true };
    },
    heightOf: function () {
      return o.want === undefined ? 20 : o.want;
    },
  }, o.deps || {});
  const c = LC.createController(deps);
  c.notePayload(o.payload || payload());
  return { c: c, o: o, reports: reports, announces: announces, view: v };
}

test('LIMITS 与等高容差是设计里写死的那几个数', () => {
  assert.deepStrictEqual(LC.LIMITS, { maxBlockLines: 2000, maxBlockBytes: 256 * 1024 });
  assert.strictEqual(LC.HEIGHT_TOLERANCE, 0.5);
  assert.strictEqual(LC.MAX_COMMIT_ROUNDS, 3);
});

test('sliceLines 按 0-based 半开取 fullText 的行区间，越界由 slice 夹取', () => {
  const text = 'a\nb\nc';
  assert.deepStrictEqual(LC.sliceLines(text, 0, 2), ['a', 'b']);
  assert.deepStrictEqual(LC.sliceLines(text, 1, 3), ['b', 'c']);
  assert.deepStrictEqual(LC.sliceLines(text, 0, 99), ['a', 'b', 'c']);
  assert.deepStrictEqual(LC.sliceLines(text, 2, 1), []);
});

test('rangeOf 原样交回块的行区间，不做 1-based 换算', () => {
  assert.deepStrictEqual(LC.rangeOf({ from: 3, to: 7, startLine: 4, endLine: 7 }), { from: 3, to: 7 });
});

test('identOfPayload 统一 gen 与 generation，缺字段不猜', () => {
  assert.deepStrictEqual(
    LC.identOfPayload({ real_path: '/x', generation: 2, doc_seq: 3, line_count: 4 }),
    { realPath: '/x', generation: 2, docSeq: 3, lineCount: 4 }
  );
  assert.deepStrictEqual(LC.identOfPayload({ gen: 9 }), {
    realPath: '', generation: 9, docSeq: undefined, lineCount: undefined,
  });
  assert.deepStrictEqual(LC.identOfPayload(null), {
    realPath: '', generation: null, docSeq: null, lineCount: null,
  });
});

test('replyOfPayload 只给 acceptReply 认的五个键', () => {
  assert.deepStrictEqual(
    LC.replyOfPayload({
      real_path: '/x', gen: 2, doc_seq: 3, line_count: 4, commit_seq: 5, html: '<p>',
    }),
    { real_path: '/x', generation: 2, doc_seq: 3, line_count: 4, commit_seq: 5 }
  );
});

test('没有文档时控制器的只读面全是空值，状态是 viewing', () => {
  const { c } = harness();
  c.notePayload({});
  assert.strictEqual(c.state(), 'viewing');
  assert.strictEqual(c.isEditing(), false);
  assert.strictEqual(c.activeIndex(), null);
  assert.strictEqual(c.activeView(), null);
  assert.strictEqual(c.lines(), null);
  assert.strictEqual(c.fullText(), null);
  assert.strictEqual(c.lineCount(), 0);
  assert.strictEqual(c.stackSize(), 0);
  assert.strictEqual(c.canUndo(), false);
  assert.strictEqual(c.canRedo(), false);
  assert.deepStrictEqual(c.blocks(), []);
  assert.strictEqual(c.activeCell(), null);
  assert.strictEqual(c.activeCellForNav(), null);
  assert.strictEqual(c.isNewParagraph(), false);
  assert.strictEqual(c.lastTransaction(), null);
  assert.strictEqual(c.envelope(), null);
});

test('notePayload 解析块表、身份、单元格与任务表', () => {
  const { c } = harness({
    payload: payload({
      table_cells: [[0, [[1, 1, 2, 1]]]],
      task_items: [[0, [[1, 3, 4, 0, 1]]]],
    }),
  });
  assert.deepStrictEqual(c.identity(), {
    realPath: '/a.md', generation: 1, docSeq: 1, lineCount: 2,
  });
  assert.strictEqual(c.blocks().length, 1);
  assert.strictEqual(c.cellsOf(0).length, 1);
  assert.strictEqual(c.tasksOf(0).length, 1);
  assert.strictEqual(c.cellsOf(1), null);
  assert.strictEqual(c.tasksOf(1), null);
});

test('begin 找不到块 / 没有节点 / 没有文档时各自给出明确原因', async () => {
  const a = harness();
  assert.deepStrictEqual(await a.c.begin({ index: 9, el: {} }), { ok: false, why: 'no-block' });
  assert.deepStrictEqual(await a.c.begin({ index: 0 }), { ok: false, why: 'no-node' });

  const b = LC.createController({});
  assert.deepStrictEqual(await b.begin({ block: {}, el: {} }), { ok: false, why: 'no-document' });
});

test('begin 在块表有 issue 时拒绝进入，避免行号指向别处', async () => {
  const { c, reports } = harness({
    payload: payload({ blocks: [[0, 1, 2, 1], [0, 1, 1, 1]] }),
  });
  const out = await c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: false, why: 'issues' });
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].err, true);
});

test('begin 对不可编辑块给出具体原因（HTML / Math / 结构）', async () => {
  const html = harness({
    payload: payload({ block_kinds: ['HtmlBlock'], blocks: [[0, 1, 2, 0]] }),
  });
  assert.deepStrictEqual(await html.c.begin({ index: 0, el: {} }), { ok: false, why: 'not-editable' });
  assert.match(html.reports[0].m, /live-why-html/);

  const math = harness({
    payload: payload({ block_kinds: ['Math'], blocks: [[0, 1, 2, 0]] }),
  });
  await math.c.begin({ index: 0, el: {} });
  assert.match(math.reports[0].m, /live-why-math/);

  const other = harness({
    payload: payload({ block_kinds: ['Other'], blocks: [[0, 1, 2, 0]] }),
  });
  await other.c.begin({ index: 0, el: {} });
  assert.match(other.reports[0].m, /live-why-structural/);
});

test('begin 的单元格入口：没有区间表 / 下标越界 / 只读格分别拒绝', async () => {
  const none = harness();
  assert.deepStrictEqual(
    await none.c.begin({ index: 0, el: {}, cell: { flat: 0 } }),
    { ok: false, why: 'no-cells' }
  );

  const short = harness({
    payload: payload({
      line_count: 1, block_kinds: ['Table'], blocks: [[0, 1, 1, 0]], table_cells: [[0, []]],
    }),
  });
  assert.deepStrictEqual(
    await short.c.begin({ index: 0, el: {}, cell: { flat: 0 } }),
    { ok: false, why: 'cell-pairing' }
  );

  const locked = harness({
    payload: payload({
      line_count: 1,
      block_kinds: ['Table'],
      blocks: [[0, 1, 1, 0]],
      table_cells: [[0, [[1, 1, 3, 0]]]],
    }),
  });
  assert.deepStrictEqual(
    await locked.c.begin({ index: 0, el: {}, cell: { flat: 0 } }),
    { ok: false, why: 'cell-locked' }
  );
});

test('begin 在行数超过 maxBlockLines 时不申请写授权', async () => {
  const { c, o, reports } = harness({
    payload: payload({ line_count: 3, blocks: [[0, 1, 3, 1]] }),
    deps: { limits: { maxBlockLines: 2 } },
  });
  const out = await c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: false, why: 'too-large' });
  assert.strictEqual(o.endEditCalls, undefined);
  assert.strictEqual(reports[0].err, true);
});

test('begin 成功：进入编辑态、建会话、建视图并交换宿主', async () => {
  const { c, o, view } = harness();
  const out = await c.begin({ index: 0, el: { tag: 'p' } });
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(c.state(), 'editing');
  assert.strictEqual(c.isEditing(), true);
  assert.strictEqual(c.activeIndex(), 0);
  assert.strictEqual(c.activeView(), view);
  assert.deepStrictEqual(o.viewOpts.text, '- a\n- b');
  assert.deepStrictEqual(o.viewOpts.lineOffset, 0);
  assert.strictEqual(o.viewOpts.cell, false);
  assert.strictEqual(o.swapUndos, undefined);
  assert.strictEqual(c.fullText(), '- a\n- b');
  assert.strictEqual(c.lineCount(), 2);
  assert.strictEqual(c.isDirty(), false);
});

test('begin 把 caretPos / caretEdge / point 交给视图落点，优先级固定', async () => {
  const a = harness();
  await a.c.begin({ index: 0, el: {}, caretPos: 0, point: { x: 1, y: 1 } });
  assert.deepStrictEqual(a.view.focus, { pos: 0 });

  const b = harness();
  await b.c.begin({ index: 0, el: {}, caretEdge: 'end', point: { x: 1, y: 1 } });
  assert.deepStrictEqual(b.view.focus, { pos: '- a\n- b'.length });

  const d = harness();
  await d.c.begin({ index: 0, el: {}, point: { x: 1, y: 1 } });
  assert.deepStrictEqual(d.view.focus, { x: 1, y: 1 });
});

test('begin 在 beginEdit 抛错时退回 viewing 并保留原因', async () => {
  const { c, reports } = harness({
    deps: {
      beginEdit: async function () {
        throw new Error('no-grant');
      },
    },
  });
  const out = await c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: false, why: 'begin-edit' });
  assert.strictEqual(c.state(), 'viewing');
  assert.match(reports[0].m, /live-enter-failed/);
});

test('begin 的四件套：磁盘行数变了就自动重载，并归还授权', async () => {
  const calls = [];
  const { c, o, reports } = harness({
    grant: { real_path: '/a.md', text: 'x\ny\nz', envelope: {} },
    deps: {
      onStaleDocument: function (x) {
        calls.push(x);
      },
    },
  });
  const out = await c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: false, why: 'identity' });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].why, /live-why-line-count/);
  assert.deepStrictEqual(o.endEditCalls, [{ discard: true }]);
  assert.match(reports[0].m, /live-reloading/);
  assert.strictEqual(reports[0].err, false);
});

test('begin 对 lossy 行尾拒绝就地编辑，不把整篇行尾改写', async () => {
  const { c, o, reports } = harness({
    grant: { real_path: '/a.md', text: '- a\n- b', envelope: { lossy: true } },
  });
  const out = await c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: false, why: 'eol' });
  assert.deepStrictEqual(o.endEditCalls, [{ discard: true }]);
  assert.match(reports[0].m, /live-eol/);
});

test('begin 的字节上限按 UTF-8 字节判，而不是 UTF-16 码元', async () => {
  const { c, reports } = harness({
    grant: { real_path: '/a.md', text: '中文', envelope: {} },
    payload: payload({ line_count: 1, blocks: [[0, 1, 1, 1]] }),
    deps: { limits: { maxBlockBytes: 5 } },
  });
  const out = await c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: false, why: 'too-large' });
  assert.match(reports[0].m, /live-block-too-large-bytes/);
});

test('begin 的单元格入口只把那一列的源码切进视图，并还原 <br>', async () => {
  const { c, o } = harness({
    payload: payload({
      line_count: 1,
      block_kinds: ['Table'],
      blocks: [[0, 1, 1, 0]],
      table_cells: [[0, [[1, 1, 7, 1]]]],
    }),
    grant: { real_path: '/a.md', text: '|a<br>b|', envelope: {} },
  });
  const out = await c.begin({ index: 0, el: {}, cell: { flat: 0 } });
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(o.viewOpts.text, 'a\nb');
  assert.strictEqual(o.viewOpts.cell, true);
  assert.deepStrictEqual(c.activeCell(), {
    blockIndex: 0, flat: 0, line: 1, from: 1, to: 7,
  });
  assert.deepStrictEqual(c.activeCellForNav(), c.activeCell());
});

// ⚠️ 现状（缺陷）：进入必须成功（`INV-KERNEL-05` ①），但"变矮"不是合规形态——
//    `INV-LIVE-04` ① 要求进入瞬间块高逐像素不变（2026-11-09 收口）。
test('⚠️ 现状（缺陷）：视图变矮只告警不拦进入（INV-KERNEL-05 ①）', async () => {
  const warns = [];
  const old = console.warn;
  console.warn = function (m) {
    warns.push(String(m));
  };
  const { c, view, reports } = harness();
  view.want = 5;
  try {
    const out = await c.begin({ index: 0, el: {} });
    assert.deepStrictEqual(out, { ok: true });
  } finally {
    console.warn = old;
  }
  assert.strictEqual(c.state(), 'editing');
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /变矮/);
  assert.match(reports[0].m, /live-short/);
});

test('commit 在视图与真值相同时报 unchanged，不压撤销条目', async () => {
  const { c, o } = harness();
  await c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(await c.commit(), { committed: false, failed: false, why: '' });
  assert.strictEqual(c.stackSize(), 0);
  assert.strictEqual(o.mountCalls, undefined);
});

test('commit 改动后发布：挂载、推进会话、载荷字段齐全', async () => {
  const { c, o, announces } = harness();
  await c.begin({ index: 0, el: {} });
  c.activeView().rows = ['- a', '- c'];
  const out = await c.commit();
  assert.deepStrictEqual(out, { committed: true, failed: false, why: '' });
  assert.strictEqual(o.mountCalls, 1);
  assert.strictEqual(c.fullText(), '- a\n- c');
  const tx = c.lastTransaction();
  assert.strictEqual(tx.status, 'committed');
  assert.strictEqual(tx.mode, 'live');
  assert.strictEqual(tx.operation, 'edit');
  assert.strictEqual(tx.objectKind, 'block');
  assert.strictEqual(tx.fullText, '- a\n- c');
  assert.deepStrictEqual(tx.lines, ['- a', '- c']);
  assert.strictEqual(tx.lineCount, 2);
  assert.deepStrictEqual(announces, ['status.live-committed']);
  assert.strictEqual(c.stackSize(), 1);
});

test('commit 的候选没变时不发 renderPreview，也不挂载', async () => {
  let previews = 0;
  const { c, o } = harness({
    deps: {
      renderPreview: async function () {
        previews++;
        return payload();
      },
    },
  });
  await c.begin({ index: 0, el: {} });
  await c.commit();
  assert.strictEqual(previews, 0);
  assert.strictEqual(o.mountCalls, undefined);
});

test('leave 默认提交并销毁视图，成功时归还写授权', async () => {
  const { c, o, view } = harness();
  await c.begin({ index: 0, el: {} });
  const out = await c.leave();
  assert.deepStrictEqual(out, { ok: true, committed: false });
  assert.strictEqual(c.state(), 'viewing');
  assert.strictEqual(c.activeIndex(), null);
  assert.strictEqual(view.destroyed, 1);
  assert.deepStrictEqual(o.endEditCalls, [{ discard: true }]);
});

test('leave 提交失败时视图和活动块都留着，输入不被销毁', async () => {
  const failing = harness({
    deps: {
      renderPreview: async function () {
        throw new Error('preview-down');
      },
    },
  });
  await failing.c.begin({ index: 0, el: {} });
  failing.c.activeView().rows = ['- a', '- c'];
  const out = await failing.c.leave();
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.failed, true);
  assert.strictEqual(failing.c.state(), 'editing');
  assert.strictEqual(failing.c.activeIndex(), 0);
  assert.strictEqual(failing.view.destroyed, 0);
  assert.ok(failing.reports.length > 0);
});

test('leave({discard:true}) 丢掉视图内容并显式归还授权', async () => {
  const { c, o, view } = harness();
  await c.begin({ index: 0, el: {} });
  c.activeView().rows = ['- changed'];
  const out = await c.leave({ discard: true });
  assert.deepStrictEqual(out, { ok: true, committed: false });
  assert.strictEqual(view.destroyed, 1);
  assert.deepStrictEqual(o.endEditCalls, [{ discard: true }]);
  assert.strictEqual(c.fullText(), '- a\n- b');
});

test('save 在没有改动时不写盘', async () => {
  const { c, o } = harness();
  await c.begin({ index: 0, el: {} });
  assert.strictEqual(await c.save(), true);
  assert.strictEqual(o.saves, undefined);
});

test('save 先提交再写盘，写的是发起时那份快照', async () => {
  const { c, o } = harness();
  await c.begin({ index: 0, el: {} });
  c.activeView().rows = ['- a', '- c'];
  assert.strictEqual(await c.save(), true);
  assert.strictEqual(o.saves.length, 1);
  assert.strictEqual(o.saves[0].text, '- a\n- c');
  assert.strictEqual(c.fullText(), '- a\n- c');
  assert.strictEqual(c.isDirty(), false);
});

test('save 在提交失败时绝不写盘', async () => {
  const { c, o } = harness({
    deps: {
      renderPreview: async function () {
        throw new Error('preview-down');
      },
    },
  });
  await c.begin({ index: 0, el: {} });
  c.activeView().rows = ['- a', '- c'];
  assert.strictEqual(await c.save(), false);
  assert.strictEqual(o.saves, undefined);
  assert.strictEqual(c.isEditing(), true);
});

test('save 发现磁盘基线被外部改过时拒绝覆盖并归还授权', async () => {
  const { c, o } = harness();
  await c.begin({ index: 0, el: {} });
  c.activeView().rows = ['- a', '- c'];
  await c.leave();
  assert.strictEqual(c.state(), 'viewing');
  o.grant = { real_path: '/a.md', text: 'other\nlines', envelope: {} };
  assert.strictEqual(await c.save(), false);
  assert.strictEqual(o.saves, undefined);
  assert.ok(o.endEditCalls.length >= 2);
});

test('发布段挂载抛错时成对回滚，且之后的 save 一律拒绝', async () => {
  const { c, o } = harness({ mountThrows: true });
  await c.begin({ index: 0, el: {} });
  c.activeView().rows = ['- a', '- c'];
  const out = await c.commit();
  assert.strictEqual(out.failed, true);
  assert.strictEqual(c.fullText(), '- a\n- b');
  assert.strictEqual(c.isEditing(), true);
  const before = o.saves ? o.saves.length : 0;
  assert.strictEqual(await c.save(), false);
  assert.strictEqual(o.saves ? o.saves.length : 0, before);
});

test('viewing 态的撤销 / 重做走提交栈，候选来自 peek，落地改真值', async () => {
  const { c } = harness();
  await c.begin({ index: 0, el: {} });
  c.activeView().rows = ['- a', '- c'];
  await c.commit();
  await c.leave();
  assert.strictEqual(c.canUndo(), true);
  assert.strictEqual(c.canRedo(), false);
  assert.strictEqual(await c.undo(), true);
  assert.strictEqual(c.fullText(), '- a\n- b');
  assert.strictEqual(c.canUndo(), false);
  assert.strictEqual(c.canRedo(), true);
  assert.strictEqual(await c.redo(), true);
  assert.strictEqual(c.fullText(), '- a\n- c');
  assert.strictEqual(c.canUndo(), true);
  assert.strictEqual(c.canRedo(), false);
});

test('编辑态下 viewing 的撤销 / 重做不接活', async () => {
  const { c } = harness();
  await c.begin({ index: 0, el: {} });
  assert.strictEqual(await c.undo(), false);
  assert.strictEqual(await c.redo(), false);
});

test('reset 丢弃活动视图、会话、基线与块表，回到 viewing', async () => {
  const { c, view } = harness();
  await c.begin({ index: 0, el: {} });
  await c.reset();
  assert.strictEqual(c.state(), 'viewing');
  assert.strictEqual(c.activeIndex(), null);
  assert.strictEqual(view.destroyed, 1);
  assert.strictEqual(c.fullText(), null);
  assert.strictEqual(c.identity(), null);
  assert.deepStrictEqual(c.blocks(), []);
  assert.strictEqual(c.isDirty(), false);
});

test('focusPoint 只在编辑态且有 focusAt 时生效', async () => {
  const { c, view } = harness();
  const old = console.warn;
  console.warn = function () {};
  try {
    assert.strictEqual(c.focusPoint({ x: 1, y: 2 }), false);
    await c.begin({ index: 0, el: {} });
    assert.strictEqual(c.focusPoint({ x: 1, y: 2 }), true);
    assert.deepStrictEqual(view.focus, { x: 1, y: 2 });
  } finally {
    console.warn = old;
  }
});

test('newParagraph 在没有活动块或没有临时宿主时直接返回 false', async () => {
  const { c } = harness();
  assert.strictEqual(await c.newParagraph(), false);
  await c.begin({ index: 0, el: {} });
  assert.strictEqual(await c.newParagraph(), false);
});

test('toggleTask：数量 / 状态 / 可写三项逐个配对，任一不符都不翻', async () => {
  const base = {
    line_count: 1,
    blocks: [[0, 1, 1, 1]],
    task_items: [[0, [[1, 3, 4, 0, 1]]]],
  };
  const count = harness({ payload: payload(base) });
  assert.deepStrictEqual(
    await count.c.toggleTask({ index: 0, flat: 0, domCount: 2, domChecked: false }),
    { ok: false, why: 'task-pairing' }
  );

  const checked = harness({ payload: payload(base) });
  assert.deepStrictEqual(
    await checked.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: true }),
    { ok: false, why: 'task-pairing' }
  );

  const locked = harness({
    payload: payload({ line_count: 1, blocks: [[0, 1, 1, 1]], task_items: [[0, [[1, 3, 4, 0, 0]]]] }),
  });
  assert.deepStrictEqual(
    await locked.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false }),
    { ok: false, why: 'task-locked' }
  );
});

test('toggleTask 成功：同长度翻转、进事务、自动写盘并报勾选状态', async () => {
  const { c, o, reports, announces } = harness({
    payload: payload({
      line_count: 1,
      blocks: [[0, 1, 1, 1]],
      task_items: [[0, [[1, 3, 4, 0, 1]]]],
    }),
    grant: { real_path: '/a.md', text: '- [ ] t', envelope: {} },
  });
  const out = await c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false });
  assert.deepStrictEqual(out, { ok: true, checked: true, saved: true });
  assert.strictEqual(c.fullText(), '- [x] t');
  assert.strictEqual(o.saves.length, 1);
  assert.strictEqual(o.saves[0].text, '- [x] t');
  assert.deepStrictEqual(announces, ['status.live-committed', 'status.task-checked']);
  assert.ok(reports.length > 0);
});

test('toggleTask 在进入前文档已脏时不替用户偷偷保存别的改动', async () => {
  const { c, o } = harness({
    payload: payload({
      line_count: 1,
      blocks: [[0, 1, 1, 1]],
      task_items: [[0, [[1, 3, 4, 0, 1]]]],
    }),
    grant: { real_path: '/a.md', text: '- [ ] t', envelope: {} },
    deps: {
      // 每个候选都重新给出任务区间，否则提交后的块表会把这一项丢掉。
      renderPreview: async function () {
        return payload({
          line_count: 1,
          blocks: [[0, 1, 1, 1]],
          task_items: [[0, [[1, 3, 4, 0, 1]]]],
          commit_seq: 99,
        });
      },
    },
  });
  // 先进入并提交一处别的改动：会话真值变了，磁盘基线仍是旧文本 ⇒ 脏。
  await c.begin({ index: 0, el: {} });
  c.activeView().rows = ['- [ ] z'];
  await c.commit();
  assert.strictEqual(c.isDirty(), true);
  const out = await c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false });
  assert.deepStrictEqual(out, { ok: true, checked: true, saved: false });
  assert.strictEqual(o.saves, undefined);
  assert.strictEqual(c.isDirty(), true);
});
