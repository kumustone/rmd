// 高度搬运与控制器装配：盒子属性采样、等高告警只提示不拦人、锚点/落点交接、
// 桶内生命周期（reset / 退出顺序 / 发布失败 / 打勾 / 新起一段）。
// 守的是 `INV-KERNEL-05`、`INV-LIVE-06/17/20`、`INV-TASK-01/03/04/06`；
// 历史缺陷见 `bugs/0013`、`0018`、`0025`、`0064`、`0077`、`0078`、`0079`、
// `0083`、`0089`、`0104`、`0107`。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadModule(rel) {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', src)(win);
  return { api: win.rmd, win: win };
}

function loadBox() {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, 'src/live/box.js'), 'utf8');
  new Function('window', src)(win);
  return { box: win.rmd.liveBox, win: win };
}

const BOX = loadBox().box;

const DEPS = ['model', 'blocks', 'cell', 'task', 'objects', 'txn'];

function loadController() {
  const win = {};
  for (const name of DEPS) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'live', name + '.js'), 'utf8');
    new Function('window', src)(win);
  }
  const src = fs.readFileSync(path.join(ROOT, 'src', 'live', 'index.js'), 'utf8');
  new Function('window', src)(win);
  return win.rmd;
}

const R = loadController();
const LC = R.liveController;

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

function defaultPreview(req) {
  const n = req.text.split('\n').length;
  return payload({ line_count: n, blocks: [[0, 1, n, 1]], commit_seq: 99 });
}

/** 打勾用例专用：回包跟着候选文本给出勾选状态，块表才不会被下一步丢掉。 */
function taskPreview(req) {
  const n = req.text.split('\n').length;
  const checked = /\[[xX]\]/.test(req.text);
  return payload({
    line_count: n,
    block_kinds: ['List'],
    blocks: [[0, 1, n, 1]],
    task_items: [[0, [[1, 3, 4, checked ? 1 : 0, 1]]]],
    commit_seq: 99,
  });
}

function view(lines) {
  const v = {
    rows: lines.slice(),
    dom: { kind: 'host' },
    want: 20,
    destroyed: 0,
    focus: null,
    height: function () {
      return v.want;
    },
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
      return v.caretPos === undefined ? 0 : v.caretPos;
    },
  };
  return v;
}

function harness(over) {
  const o = over || {};
  const reports = [];
  const announces = [];
  const v = o.view || view(o.viewLines || ['- a', '- b']);
  let disk = o.diskText === undefined ? '- a\n- b' : o.diskText;
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
      return { real_path: '/a.md', text: disk, envelope: { eol: 'lf' } };
    },
    endEdit: async function (x) {
      (o.endEditCalls || (o.endEditCalls = [])).push(x);
    },
    renderPreview: async function (req) {
      return o.preview ? o.preview(req) : defaultPreview(req);
    },
    mount: function () {
      o.mountCalls = (o.mountCalls || 0) + 1;
      if (o.mountThrows) throw new Error('mount-boom');
    },
    saveDisk: async function (p) {
      (o.saves || (o.saves = [])).push(p);
      if (o.saveThrows) throw new Error('disk-full');
      disk = p.text;
    },
    makeView: function (opts) {
      o.viewOpts = opts;
      v.rows = String(opts.text).split('\n');
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
    pendingHost: function () {
      o.hostCalls = (o.hostCalls || 0) + 1;
      return { parentNode: null, host: true };
    },
    heightOf: function () {
      return o.want === undefined ? 20 : o.want;
    },
  }, o.deps || {});
  const c = LC.createController(deps);
  c.notePayload(o.payload || payload());
  return {
    c: c,
    o: o,
    reports: reports,
    announces: announces,
    view: v,
    diskText: function () {
      return disk;
    },
  };
}

// ── 版面搬运的纯逻辑（`src/live/box.js`）─────────────────────────────────
// 这几样任何行为判据都碰不到：外边距/内边距/底色丢了，高度校验和屏幕都不会说。

test('PROPS 恰好 17 项，文字族与盒子族一个不少（顺序即契约）', () => {
  assert.deepStrictEqual(BOX.PROPS.map(function (p) { return p[0]; }), [
    'font-size',
    'line-height',
    'font-weight',
    'margin-top',
    'margin-bottom',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-left-width',
    'border-left-style',
    'border-left-color',
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-left-radius',
    'border-bottom-right-radius',
    'background-color',
  ]);
});

test('boxOf 按 getComputedStyle 的驼峰名取值，再映射回 CSS 属性名', () => {
  const cs = {};
  for (const pair of BOX.PROPS) cs[pair[1]] = 'x-' + pair[0];
  const out = BOX.boxOf(cs);
  for (const pair of BOX.PROPS) {
    assert.strictEqual(out[pair[0]], 'x-' + pair[0], pair[0]);
  }
  // 只放 CSS 名、不放驼峰名时读不到（防止实现退化成 cs[css]）。
  const onlyCss = {};
  onlyCss['margin-bottom'] = '15.4px';
  assert.deepStrictEqual(BOX.boxOf(onlyCss), {});
});

test('INERT 恰好是 none / transparent / 0px 三样', () => {
  assert.deepStrictEqual(BOX.INERT, { none: true, transparent: true, '0px': true });
});

test('boxOf 对空输入返回空对象，不抛错', () => {
  assert.deepStrictEqual(BOX.boxOf(null), {});
  assert.deepStrictEqual(BOX.boxOf(undefined), {});
});

test('boxOf 跳过空串与非字符串（老 WebKit 会给出 undefined）', () => {
  assert.deepStrictEqual(BOX.boxOf({ fontSize: '', marginTop: undefined, paddingTop: 3 }), {});
});

test('boxOf 丢弃 inert 值：none / transparent / 0px 都不写到 host 上', () => {
  assert.deepStrictEqual(
    BOX.boxOf({
      marginTop: 'none',
      borderLeftStyle: 'none',
      borderLeftWidth: '0px',
      backgroundColor: 'transparent',
    }),
    {}
  );
});

test('boxOf 丢弃 alpha=0 的底色（三套主题的引用块底都是透明的）', () => {
  assert.deepStrictEqual(
    BOX.boxOf({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(0, 0, 0)' }),
    {}
  );
  assert.deepStrictEqual(
    BOX.boxOf({ backgroundColor: 'rgb(0, 0, 0, 0.0)', color: 'rgb(0, 0, 0)' }),
    {}
  );
});

test('boxOf 保留不透明底色与 alpha 非零的半透明底色', () => {
  assert.deepStrictEqual(BOX.boxOf({ backgroundColor: 'rgb(30, 30, 30)' }), {
    'background-color': 'rgb(30, 30, 30)',
  });
  assert.deepStrictEqual(BOX.boxOf({ backgroundColor: 'rgba(0, 0, 0, 0.2)' }), {
    'background-color': 'rgba(0, 0, 0, 0.2)',
  });
});

test('boxOf 只按四分量判透明；五分量（异常形状）不误判成透明', () => {
  assert.deepStrictEqual(BOX.boxOf({ backgroundColor: 'rgb(1, 2, 3, 0, 9)' }), {
    'background-color': 'rgb(1, 2, 3, 0, 9)',
  });
});

test('boxOf 不以 rgb 开头的值（主题给的命名色）原样保留', () => {
  assert.deepStrictEqual(BOX.boxOf({ backgroundColor: 'canvastext' }), {
    'background-color': 'canvastext',
  });
});

test('boxOf 是纯函数：不改传进来的 CSSStyleDeclaration 形状', () => {
  const cs = { marginBottom: '15.4px', backgroundColor: 'transparent' };
  const before = Object.assign({}, cs);
  BOX.boxOf(cs);
  assert.deepStrictEqual(cs, before);
});

test('boxOf 的结果里没有 PROPS 之外的键（写入口不会被顺手放大）', () => {
  const cs = { fontSize: '14px', color: 'red', display: 'block', marginBottom: '15.4px' };
  assert.deepStrictEqual(Object.keys(BOX.boxOf(cs)).sort(), ['font-size', 'margin-bottom']);
});

test('classNameOf 只给代码块加 cm-rmd-code，标签名大小写不敏感', () => {
  assert.strictEqual(BOX.classNameOf({ tagName: 'pre' }), ' cm-rmd-code');
  assert.strictEqual(BOX.classNameOf({ tagName: 'PRE' }), ' cm-rmd-code');
  assert.strictEqual(BOX.classNameOf({ tagName: 'p' }), '');
  assert.strictEqual(BOX.classNameOf({ tagName: 'ul' }), '');
  assert.strictEqual(BOX.classNameOf(null), '');
  assert.strictEqual(BOX.classNameOf({ tagName: 5 }), '');
});

test('headingLevelOf 认 H1–H6 的标签名，其余一律 0', () => {
  for (let i = 1; i <= 6; i++) assert.strictEqual(BOX.headingLevelOf({ tagName: 'H' + i }), i);
  assert.strictEqual(BOX.headingLevelOf({ tagName: 'h3' }), 3);
  assert.strictEqual(BOX.headingLevelOf({ tagName: 'H7' }), 0);
  assert.strictEqual(BOX.headingLevelOf({ tagName: 'H10' }), 0);
  assert.strictEqual(BOX.headingLevelOf({ tagName: 'P' }), 0);
  assert.strictEqual(BOX.headingLevelOf(null), 0);
  assert.strictEqual(BOX.headingLevelOf({}), 0);
});

test('applyBox 把量到的盒子逐条 setProperty 到 host，且量的是被替换元素', () => {
  const m = loadBox();
  const seen = [];
  m.win.getComputedStyle = function (el) {
    seen.push(el);
    return { fontSize: '16px', marginBottom: '15.4px', backgroundColor: 'transparent' };
  };
  const writes = [];
  const host = {
    style: {
      setProperty: function (k, v) {
        writes.push([k, v]);
      },
    },
  };
  const el = { tagName: 'P' };
  m.box.applyBox(host, el);
  assert.deepStrictEqual(seen, [el]);
  assert.deepStrictEqual(writes, [
    ['font-size', '16px'],
    ['margin-bottom', '15.4px'],
  ]);
});

test('applyBox 在 host 已有内联值时只补写、不整份替换', () => {
  const m = loadBox();
  m.win.getComputedStyle = function () {
    return { paddingLeft: '20px' };
  };
  const existing = { 'line-height': '20.3px' };
  const host = {
    style: {
      setProperty: function (k, v) {
        existing[k] = v;
      },
    },
  };
  m.box.applyBox(host, { tagName: 'UL' });
  assert.deepStrictEqual(existing, { 'line-height': '20.3px', 'padding-left': '20px' });
});

test('applyBox 在没有 getComputedStyle 的宿主里静默返回（离屏探针/老内核）', () => {
  const m = loadBox();
  let calls = 0;
  const host = {
    style: {
      setProperty: function () {
        calls++;
      },
    },
  };
  assert.strictEqual(m.win.getComputedStyle, undefined);
  assert.doesNotThrow(function () {
    m.box.applyBox(host, { tagName: 'P' });
  });
  assert.strictEqual(calls, 0);
});

test('applyBox 对 host 没有 style / el 为空都不碰 getComputedStyle', () => {
  const m = loadBox();
  let calls = 0;
  m.win.getComputedStyle = function () {
    calls++;
    return {};
  };
  assert.doesNotThrow(function () {
    m.box.applyBox({}, { tagName: 'P' });
    m.box.applyBox({ style: {} }, null);
    m.box.applyBox(null, { tagName: 'P' });
  });
  assert.strictEqual(calls, 0);
});

// ── 等高校验（`INV-KERNEL-05`）──────────────────────────────────────────

test('等高差为 0 时什么也不报（干净进入）', async () => {
  const a = harness();
  const out = await a.c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: true });
  assert.deepStrictEqual(a.reports, []);
  assert.strictEqual(a.c.state(), 'editing');
});

test('容差边界 -0.5 不报，-0.5001 才报（<= 与 < 的分界）', async () => {
  const exact = harness({ want: 20 });
  exact.view.want = 19.5;
  await exact.c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(exact.reports, []);

  const over = harness({ want: 20 });
  over.view.want = 19.4999;
  await over.c.begin({ index: 0, el: {} });
  assert.strictEqual(over.reports.length, 1);
  assert.match(over.reports[0].m, /live-short/);
});

test('判据用未取整的原值：差 -0.46 即使显示成 20 → 19.5 也不报', async () => {
  const a = harness({ want: 19.96 });
  a.view.want = 19.5;
  await a.c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(a.reports, []);
});

test('变高一律不报（每块弹一句会淹掉真错误）', async () => {
  const a = harness({ want: 20 });
  a.view.want = 120;
  const out = await a.c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: true });
  assert.deepStrictEqual(a.reports, []);
});

test('单元格形态不做等高告警（格子的盒子定义与块不同）', async () => {
  const a = harness({
    want: 30,
    payload: payload({
      line_count: 1,
      block_kinds: ['Table'],
      blocks: [[0, 1, 1, 0]],
      table_cells: [[0, [[1, 1, 7, 1]]]],
    }),
    diskText: '|a<br>b|',
  });
  a.view.want = 2;
  const out = await a.c.begin({ index: 0, el: {}, cell: { flat: 0 } });
  assert.deepStrictEqual(out, { ok: true });
  assert.deepStrictEqual(a.reports, []);
});

test('⚠️ 现状（缺陷）：源自 docs/bugs/0083（进入引用/列表/带图段落时状态条报变矮）', async () => {
  // ⚠️ 变矮**必须报**：那是字号/行高/内边距搬丢了的唯一可见线索。
  // ⛔⛔ 2026-11-09 起"只提示、不拦人"**不是合规形态**：`INV-LIVE-04` ① 要求进入瞬间
  //    逐像素不动，变矮本身是缺陷（`bugs/0298` 一族）。本条只钉住"预算内不要更糟"，
  //    ⛔ 别把"能进去"读成"产品对了"。
  const a = harness({ want: 20.141 });
  a.view.want = 5;
  const out = await a.c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(a.reports.length, 1);
  assert.strictEqual(a.reports[0].err, false);
  assert.strictEqual(a.reports[0].m, 'status.live-short({"want":20.1,"got":5})');
  assert.strictEqual(a.c.isEditing(), true);
});

test('变矮同时 console.warn 留痕，带差值、原高与实高（一位小数）', async () => {
  const warns = [];
  const old = console.warn;
  console.warn = function (m) {
    warns.push(String(m));
  };
  try {
    const a = harness({ want: 20.141 });
    a.view.want = 5;
    await a.c.begin({ index: 0, el: {} });
  } finally {
    console.warn = old;
  }
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /变矮/);
  assert.match(warns[0], /-15\.1/);
  assert.match(warns[0], /20\.1/);
  assert.match(warns[0], /→ 5/);
});

test('console.warn 自己抛错也不影响进入编辑态（留痕不能变成拦路）', async () => {
  const old = console.warn;
  console.warn = function () {
    throw new Error('warn-boom');
  };
  try {
    const a = harness({ want: 20 });
    a.view.want = 1;
    const out = await a.c.begin({ index: 0, el: {} });
    assert.deepStrictEqual(out, { ok: true });
    assert.strictEqual(a.c.isEditing(), true);
  } finally {
    console.warn = old;
  }
});

test('高度检查落在 makeView 之后、swap 之前（差值与视图必须连着）', async () => {
  const order = [];
  const reports = [];
  const v = view(['- a', '- b']);
  v.want = 5;
  const realHeight = v.height;
  v.height = function () {
    order.push('height');
    return realHeight();
  };
  const a = harness({
    view: v,
    want: 20,
    deps: {
      makeView: function () {
        order.push('makeView');
        return v;
      },
      heightOf: function () {
        order.push('heightOf');
        return 20;
      },
      report: function (m, err) {
        order.push('report');
        reports.push({ m: m, err: err });
      },
      swap: function () {
        order.push('swap');
        return { undo: function () {} };
      },
    },
  });
  await a.c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(order, ['makeView', 'heightOf', 'height', 'report', 'swap']);
  assert.strictEqual(reports.length, 1);
});

test('未注入 heightOf 时按 border box 的分数像素量，⛔ 不用取整的 offsetHeight', async () => {
  // 取整会把两侧各虚增 0.5px，与 0.5 的容差同量级（bugs/0013 的成因之一）。
  const a = harness({ deps: { heightOf: undefined } });
  a.view.want = 1;
  await a.c.begin({
    index: 0,
    el: {
      getBoundingClientRect: function () {
        return { height: 20.6 };
      },
      offsetHeight: 20,
    },
  });
  assert.strictEqual(a.reports.length, 1);
  assert.match(a.reports[0].m, /"want":20\.6/);
});

test('没有 getBoundingClientRect 时才回落 offsetHeight', async () => {
  const a = harness({ deps: { heightOf: undefined } });
  a.view.want = 1;
  await a.c.begin({ index: 0, el: { offsetHeight: 44 } });
  assert.match(a.reports[0].m, /"want":44/);
});

// ── 源自 docs/bugs/0013（高过一个视口的块进不了就地编辑）────────────────
test('0013 高过一屏的块即便量得更高也照样进得去（上界不再拒收）', async () => {
  const text = Array.from({ length: 10 }, function (_, i) { return 'line ' + i; }).join('\n');
  const a = harness({
    want: 2000,
    payload: payload({ line_count: 10, blocks: [[0, 1, 10, 1]] }),
    diskText: text,
  });
  a.view.want = 2020.141;
  const out = await a.c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(a.c.state(), 'editing');
  assert.deepStrictEqual(a.reports, []);
});

// ── 源自 docs/bugs/0025（结构差算漏一类就整块进不去）────────────────────
// ⚠️ 现状（缺陷）：`INV-LIVE-04` ① 要求进入瞬间逐像素不动 ⇒ "结构高度差"本身就是缺陷，
//    ⛔ "块仍然进得去"只是"没有更糟"（拒收是**另一个**缺陷，`INV-KERNEL-05` ①）。
test('⚠️ 现状（缺陷）：0025 结构高度差只告警不阻断，块仍然进得去', async () => {
  const a = harness({ want: 300 });
  a.view.want = 100;
  const out = await a.c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(a.reports.length, 1);
  assert.match(a.reports[0].m, /live-short/);
  assert.strictEqual(a.c.isEditing(), true);
});

// ── 源自 docs/bugs/0078（点进编辑时页面凭空滚一行）──────────────────────
// 控制器要把「用户点的那一处」与「整块」原样交给 swap：单行块与多行块的锚定规则不同。
test('0078 begin 把 point 与整块（含首末行）交给 swap', async () => {
  let args = null;
  const a = harness({
    deps: {
      swap: function (x) {
        args = x;
        return { undo: function () {} };
      },
    },
  });
  const point = { x: 12, y: 34 };
  await a.c.begin({ index: 0, el: { tag: 'P' }, point: point });
  assert.strictEqual(args.point, point);
  assert.strictEqual(args.block.startLine, 1);
  assert.strictEqual(args.block.endLine, 2);
  assert.strictEqual(args.block.kind, 'Paragraph');
  assert.strictEqual(args.cell, false);
  assert.strictEqual(args.view, a.view);
  assert.strictEqual(args.host, a.view.dom);
});

test('0078 单行块交给 swap 的行区间就是一行（视觉行 ≠ 源码行）', async () => {
  let args = null;
  const a = harness({
    payload: payload({ line_count: 1, blocks: [[0, 1, 1, 1]] }),
    diskText: '- a',
    deps: {
      swap: function (x) {
        args = x;
        return { undo: function () {} };
      },
    },
  });
  await a.c.begin({ index: 0, el: {}, point: { x: 0, y: 0 } });
  assert.strictEqual(args.block.startLine, 1);
  assert.strictEqual(args.block.endLine, 1);
});

test('makeView 拿到被替换的 el、块种类、行偏移与单元格标记', async () => {
  const a = harness();
  const el = { tag: 'H1' };
  await a.c.begin({ index: 0, el: el });
  assert.strictEqual(a.o.viewOpts.el, el);
  assert.strictEqual(a.o.viewOpts.kind, 'Paragraph');
  assert.strictEqual(a.o.viewOpts.lineOffset, 0);
  assert.strictEqual(a.o.viewOpts.cell, false);
});

// ── 源自 docs/bugs/0089（Setext 标题一进入就高出一整行）─────────────────
test('0089 Setext 标题（两行源码）变高只接受、不告警，也不拦进入', async () => {
  const a = harness({
    payload: payload({ line_count: 2, block_kinds: ['Heading'], blocks: [[0, 1, 2, 1]] }),
    diskText: '标题\n====',
    want: 40,
  });
  a.view.want = 60;
  const out = await a.c.begin({ index: 0, el: {} });
  assert.deepStrictEqual(out, { ok: true });
  assert.deepStrictEqual(a.reports, []);
  assert.strictEqual(a.o.viewOpts.text, '标题\n====');
  assert.strictEqual(a.o.viewOpts.kind, 'Heading');
});

// ── 源自 docs/bugs/0104（方向键跨格时的落点）────────────────────────────
test('0104 caretEdge=end 落在这一格解码后文本的末尾（长度现算）', async () => {
  const a = harness({
    payload: payload({
      line_count: 1,
      block_kinds: ['Table'],
      blocks: [[0, 1, 1, 0]],
      table_cells: [[0, [[1, 1, 7, 1]]]],
    }),
    diskText: '|a<br>b|',
  });
  await a.c.begin({ index: 0, el: {}, cell: { flat: 0 }, caretEdge: 'end' });
  assert.strictEqual(a.o.viewOpts.text, 'a\nb');
  assert.deepStrictEqual(a.view.focus, { pos: 3 });
});

test('0104 caretEdge=start 落在 0；未知值不乱放光标', async () => {
  const start = harness();
  await start.c.begin({ index: 0, el: {}, caretEdge: 'start' });
  assert.deepStrictEqual(start.view.focus, { pos: 0 });

  const unknown = harness();
  await unknown.c.begin({ index: 0, el: {}, caretEdge: 'middle' });
  assert.strictEqual(unknown.view.focus, null);
});

test('0104 caretPos 是整数时优先于 caretEdge（0 也算有效落点）', async () => {
  const a = harness();
  await a.c.begin({ index: 0, el: {}, caretPos: 0, caretEdge: 'end' });
  assert.deepStrictEqual(a.view.focus, { pos: 0 });
});

test('0104 caretPos 不是整数时不抢，按 caretEdge 走', async () => {
  const a = harness();
  await a.c.begin({ index: 0, el: {}, caretPos: 1.5, caretEdge: 'end' });
  assert.deepStrictEqual(a.view.focus, { pos: '- a\n- b'.length });
});

// ── 进入时的正文来源（`bugs/0017` 同族：⛔ 不从磁盘授权切）────────────────
test('视图文本来自会话缓冲，不从磁盘授权切（否则进去的是别处文字）', async () => {
  const a = harness({
    payload: payload({ line_count: 1, blocks: [[0, 1, 1, 1]] }),
    diskText: '- old',
  });
  await a.c.begin({ index: 0, el: {} });
  a.view.rows = ['- new'];
  await a.c.commit();
  assert.strictEqual(a.diskText(), '- old');
  await a.c.begin({ index: 0, el: {} });
  assert.strictEqual(a.o.viewOpts.text, '- new');
});

// ── 源自 docs/bugs/0064（换文档后旧回包把状态恢复成编辑态）────────────────
test('0064 reset 清掉视图、身份与四张表，且不提交、不重渲', async () => {
  const a = harness({
    payload: payload({ task_items: [[0, [[1, 3, 4, 0, 1]]]] }),
  });
  await a.c.begin({ index: 0, el: {} });
  assert.strictEqual(a.c.isEditing(), true);
  await a.c.reset();
  assert.strictEqual(a.c.state(), 'viewing');
  assert.strictEqual(a.c.activeIndex(), null);
  assert.strictEqual(a.view.destroyed, 1);
  assert.strictEqual(a.c.identity(), null);
  assert.deepStrictEqual(a.c.blocks(), []);
  assert.strictEqual(a.c.cellsOf(0), null);
  assert.strictEqual(a.c.tasksOf(0), null);
  assert.deepStrictEqual(a.c.issues(), []);
  assert.strictEqual(a.c.fullText(), null);
  assert.strictEqual(a.o.mountCalls, undefined);
});

test('0064 reset 打断 Prep 里的 begin：旧的那次判 superseded 并归还授权', async () => {
  let release;
  const gate = new Promise(function (res) {
    release = res;
  });
  const a = harness({
    deps: {
      beginEdit: function () {
        return gate;
      },
    },
  });
  const p = a.c.begin({ index: 0, el: {} });
  await Promise.resolve();
  await a.c.reset();
  release({ real_path: '/a.md', text: '- a\n- b', envelope: {} });
  const out = await p;
  assert.deepStrictEqual(out, { ok: false, why: 'superseded' });
  assert.strictEqual(a.c.state(), 'viewing');
  assert.deepStrictEqual(a.o.endEditCalls, [{ discard: true }]);
});

// ── 源自 docs/bugs/0018（进入之后退不出来 / 顺序错了留残影）──────────────
test('0018 退出顺序：撤销 swap → 取视图行 → 销毁 → 归还授权', async () => {
  const order = [];
  const v = view(['- a', '- b']);
  const realDestroy = v.destroy;
  v.destroy = function () {
    order.push('destroy');
    realDestroy();
  };
  const a = harness({
    view: v,
    deps: {
      swap: function () {
        order.push('swap');
        return {
          undo: function () {
            order.push('swap-undo');
          },
        };
      },
      endEdit: async function (x) {
        order.push('endEdit:' + (x && x.discard ? 'discard' : 'keep'));
      },
    },
  });
  await a.c.begin({ index: 0, el: {} });
  order.length = 0; // begin 自己那一次 swap 不算退出顺序
  const out = await a.c.leave();
  assert.deepStrictEqual(out, { ok: true, committed: false });
  assert.deepStrictEqual(order, ['swap-undo', 'destroy', 'endEdit:discard']);
});

test('0018 提交失败时视图与宿主全部保留：不撤 swap、不销毁、不归还授权', async () => {
  const order = [];
  const v = view(['- a', '- b']);
  const realDestroy = v.destroy;
  v.destroy = function () {
    order.push('destroy');
    realDestroy();
  };
  const a = harness({
    view: v,
    deps: {
      renderPreview: async function () {
        throw new Error('preview-down');
      },
      swap: function () {
        order.push('swap');
        return {
          undo: function () {
            order.push('swap-undo');
          },
        };
      },
      endEdit: async function () {
        order.push('endEdit');
      },
    },
  });
  await a.c.begin({ index: 0, el: {} });
  v.rows = ['- a', '- changed'];
  const out = await a.c.leave();
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.failed, true);
  assert.strictEqual(out.pending, true);
  assert.strictEqual(a.c.state(), 'editing');
  assert.strictEqual(v.destroyed, 0);
  assert.deepStrictEqual(order.filter(function (x) {
    return x === 'swap-undo' || x === 'destroy' || x === 'endEdit';
  }), []);
});

// ── 源自 docs/bugs/0107（编辑面的静默失败）──────────────────────────────
test('0107 写盘失败：返回 false、报红、保留脏，基线不动', async () => {
  const a = harness({ saveThrows: true });
  await a.c.begin({ index: 0, el: {} });
  a.view.rows = ['- a', '- changed'];
  await a.c.commit();
  assert.strictEqual(a.c.isDirty(), true);

  const ok = await a.c.save();
  assert.strictEqual(ok, false);
  const last = a.reports[a.reports.length - 1];
  assert.strictEqual(last.err, true);
  assert.match(last.m, /live-save-failed/);
  assert.strictEqual(a.c.isDirty(), true);
  assert.strictEqual(a.o.saves.length, 1);
});

test('0107 发布段失败后 save 明确拒绝，⛔ 不把没上屏的那份写盘', async () => {
  const a = harness({ mountThrows: true });
  await a.c.begin({ index: 0, el: {} });
  a.view.rows = ['- a', '- changed'];
  const out = await a.c.commit();
  assert.strictEqual(out.failed, true);

  const before = a.reports.length;
  const ok = await a.c.save();
  assert.strictEqual(ok, false);
  assert.strictEqual(a.o.saves, undefined);
  assert.match(a.reports[before].m, /live-publish-failed/);
});

test('0107 reset 之后发布失败标记清掉，新文档不再被上一份的残局挡住', async () => {
  const a = harness({ mountThrows: true });
  await a.c.begin({ index: 0, el: {} });
  a.view.rows = ['- a', '- changed'];
  await a.c.commit();
  await a.c.reset();
  a.c.notePayload(payload());
  await a.c.begin({ index: 0, el: {} });

  const before = a.reports.length;
  const ok = await a.c.save(); // 没有改动 ⇒ true
  assert.strictEqual(ok, true);
  assert.ok(!a.reports.slice(before).some(function (r) {
    return /publish-failed/.test(r.m);
  }));
});

// ── 源自 docs/bugs/0077（勾选任务项后正文往上跳）────────────────────────
// 翻转必须是同长度替换；控制器还要按「翻转前的行」报告勾选状态、并在干净时落盘。
test('0077 控制器打勾：全文只变一个符号，整行长度不变，勾完自动写盘', async () => {
  const a = harness({
    payload: payload({ block_kinds: ['List'], task_items: [[0, [[1, 3, 4, 0, 1]]]] }),
    diskText: '- [ ] a\n- b',
    preview: taskPreview,
  });
  const out = await a.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false });
  assert.deepStrictEqual(out, { ok: true, checked: true, saved: true });
  assert.deepStrictEqual(a.c.lines(), ['- [x] a', '- b']);
  assert.strictEqual(a.c.lines()[0].length, '- [ ] a'.length);
  assert.deepStrictEqual(a.o.saves.map(function (s) { return s.text; }), ['- [x] a\n- b']);
  assert.deepStrictEqual(a.announces, ['status.live-committed', 'status.task-checked']);
  assert.strictEqual(a.c.stackSize(), 1);
});

test('0077 已勾的项翻回未勾，状态条说的是翻转后的状态（不是双翻）', async () => {
  const a = harness({
    payload: payload({ block_kinds: ['List'], task_items: [[0, [[1, 3, 4, 1, 1]]]] }),
    diskText: '- [x] a\n- b',
    preview: taskPreview,
  });
  const out = await a.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: true });
  assert.deepStrictEqual(out, { ok: true, checked: false, saved: true });
  assert.strictEqual(a.c.lines()[0], '- [ ] a');
  assert.ok(a.reports.some(function (r) { return r.m === 'status.task-unchecked'; }));
  assert.strictEqual(a.announces[a.announces.length - 1], 'status.task-unchecked');
});

test('0077 进入前已脏时只报已提交，不替用户偷偷保存别的改动', async () => {
  const a = harness({
    payload: payload({ block_kinds: ['List'], task_items: [[0, [[1, 3, 4, 0, 1]]]] }),
    diskText: '- [ ] a\n- b',
    preview: taskPreview,
  });
  await a.c.begin({ index: 0, el: {} });
  a.view.rows = ['- [ ] z', '- b'];
  await a.c.commit();
  assert.strictEqual(a.c.isDirty(), true);

  const out = await a.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false });
  assert.deepStrictEqual(out, { ok: true, checked: true, saved: false });
  assert.strictEqual(a.c.lines()[0], '- [x] z');
  assert.strictEqual(a.o.saves, undefined);
  // 脏路径只报事务的「已提交」，不报「已勾选 / 已取消勾选」（那条只属于自动写盘成功的分支）。
  assert.strictEqual(a.announces[a.announces.length - 1], 'status.live-committed');
  assert.ok(!a.announces.some(function (m) { return /task-(checked|unchecked)/.test(m); }));
});

test('0077 配对闸门：数量 / 状态 / 下标任一不符都不翻，也不写盘', async () => {
  const base = { block_kinds: ['List'], task_items: [[0, [[1, 3, 4, 0, 1]]]] };
  const count = harness({ payload: payload(base), diskText: '- [ ] a\n- b' });
  assert.deepStrictEqual(
    await count.c.toggleTask({ index: 0, flat: 0, domCount: 2, domChecked: false }),
    { ok: false, why: 'task-pairing' }
  );

  const checked = harness({ payload: payload(base), diskText: '- [ ] a\n- b' });
  assert.deepStrictEqual(
    await checked.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: true }),
    { ok: false, why: 'task-pairing' }
  );

  const flat = harness({ payload: payload(base), diskText: '- [ ] a\n- b' });
  assert.deepStrictEqual(
    await flat.c.toggleTask({ index: 0, flat: 3, domCount: 1, domChecked: false }),
    { ok: false, why: 'task-pairing' }
  );

  assert.strictEqual(count.o.saves, undefined);
  assert.strictEqual(checked.o.saves, undefined);
  assert.strictEqual(flat.o.saves, undefined);
});

test('0077 不可写项显式拒绝（task-locked），不夹取、不猜位置', async () => {
  const a = harness({
    payload: payload({ block_kinds: ['List'], task_items: [[0, [[1, 3, 4, 0, 0]]]] }),
    diskText: '- [ ] a\n- b',
  });
  assert.deepStrictEqual(
    await a.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false }),
    { ok: false, why: 'task-locked' }
  );
});

test('0077 没有任务表 / 没有块 / 没有文档时各自给出明确原因', async () => {
  const none = harness({ diskText: '- a\n- b' });
  assert.deepStrictEqual(
    await none.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false }),
    { ok: false, why: 'no-tasks' }
  );

  const noblock = harness({
    payload: payload({ block_kinds: ['List'], task_items: [[0, [[1, 3, 4, 0, 1]]]] }),
    diskText: '- [ ] a\n- b',
  });
  assert.deepStrictEqual(
    await noblock.c.toggleTask({ index: 9, flat: 0, domCount: 1, domChecked: false }),
    { ok: false, why: 'no-block' }
  );

  const nodoc = LC.createController({});
  assert.deepStrictEqual(
    await nodoc.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false }),
    { ok: false, why: 'no-document' }
  );
});

test('0077 块表有问题时拒绝打勾（行号可能指向别处）', async () => {
  const a = harness({ payload: payload({ blocks: [[0, 1, 2, 1], [0, 1, 1, 1]] }) });
  assert.deepStrictEqual(
    await a.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false }),
    { ok: false, why: 'issues' }
  );
});

test('0077 磁盘行数与打开时不同 ⇒ 自动重载且不打勾', async () => {
  const stale = [];
  const a = harness({
    payload: payload({
      line_count: 3,
      block_kinds: ['List'],
      blocks: [[0, 1, 3, 1]],
      task_items: [[0, [[1, 3, 4, 0, 1]]]],
    }),
    diskText: '- [ ] a\n- b',
    deps: {
      onStaleDocument: function (x) {
        stale.push(x);
      },
    },
  });
  assert.deepStrictEqual(
    await a.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false }),
    { ok: false, why: 'identity' }
  );
  assert.strictEqual(stale.length, 1);
});

test('0077 退出旧块提交失败时不接着打勾（避免用陈旧行号翻错行）', async () => {
  const a = harness({
    payload: payload({ block_kinds: ['List'], task_items: [[0, [[1, 3, 4, 0, 1]]]] }),
    diskText: '- [ ] a\n- b',
    deps: {
      renderPreview: async function () {
        throw new Error('preview-down');
      },
    },
  });
  await a.c.begin({ index: 0, el: {} });
  a.view.rows = ['- [ ] changed', '- b'];
  const out = await a.c.toggleTask({ index: 0, flat: 0, domCount: 1, domChecked: false });
  assert.deepStrictEqual(out, { ok: false, why: 'commit-failed' });
  assert.strictEqual(a.c.state(), 'editing');
  assert.strictEqual(a.o.saves, undefined);
});

// ── 源自 docs/bugs/0079（⌘↵ 每用一次多留一行空行）──────────────────────
test('0079 块后没有空行时插三行：上分隔＋新段落＋下分隔', async () => {
  const a = harness();
  await a.c.begin({ index: 0, el: {} });
  assert.strictEqual(await a.c.newParagraph(), true);
  assert.deepStrictEqual(a.c.lines(), ['- a', '- b', '', '', '']);
  assert.strictEqual(a.o.viewOpts.text, '');
  assert.strictEqual(a.c.isNewParagraph(), true);
});

test('0079 块后已有一行空行时只插两行，原有空行继续当下分隔', async () => {
  const a = harness({
    payload: payload({ line_count: 3, blocks: [[0, 1, 1, 1], [0, 3, 3, 1]] }),
    diskText: '- a\n\n- b',
  });
  await a.c.begin({ index: 0, el: {} });
  assert.strictEqual(await a.c.newParagraph(), true);
  assert.deepStrictEqual(a.c.lines(), ['- a', '', '', '', '- b']);
});

test('0079 新段落里一个字没敲就退出 ⇒ 整步撤回，不留空行也不留撤销条目', async () => {
  const a = harness();
  await a.c.begin({ index: 0, el: {} });
  await a.c.newParagraph();
  assert.strictEqual(a.c.lines().length, 5);
  const out = await a.c.leave();
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(a.c.lines(), ['- a', '- b']);
  assert.strictEqual(a.c.stackSize(), 0);
});

test('0079 退出旧块提交失败时 ⛔ 不插空行（不许凭空多出空行）', async () => {
  const a = harness({
    deps: {
      renderPreview: async function () {
        throw new Error('preview-down');
      },
    },
  });
  await a.c.begin({ index: 0, el: {} });
  a.view.rows = ['- changed', '- b'];
  assert.strictEqual(await a.c.newParagraph(), false);
  assert.strictEqual(a.c.state(), 'editing');
  assert.deepStrictEqual(a.c.lines(), ['- a', '- b']);
});

test('0079 单元格形态不插空行（会把表格行拆散）', async () => {
  const a = harness({
    payload: payload({
      line_count: 1,
      block_kinds: ['Table'],
      blocks: [[0, 1, 1, 0]],
      table_cells: [[0, [[1, 1, 7, 1]]]],
    }),
    diskText: '|a<br>b|',
  });
  await a.c.begin({ index: 0, el: {}, cell: { flat: 0 } });
  assert.strictEqual(await a.c.newParagraph(), false);
});

test('0079 没有临时宿主时如实返回 false，一行空行都不插', async () => {
  const a = harness({ deps: { pendingHost: undefined } });
  await a.c.begin({ index: 0, el: {} });
  assert.strictEqual(await a.c.newParagraph(), false);
  assert.deepStrictEqual(a.c.lines(), ['- a', '- b']);
});

test('⚠️ 疑似缺陷：⌘↵ 已插入空行后建视图失败时返回 false，但空行不回滚', async () => {
  // 插入事务先提交（空行已经进真值并上屏），随后合成块的 `begin()` 失败（这里让 makeView 抛错）。
  // 代码只把临时宿主摘掉就 `return false`，**没有**撤销那次插入：调用方看到"没开出来"，
  // 而正文里已经多了三行空行（还压着一条撤销条目）。钉住现状，等设计确认要不要成对回滚。
  let calls = 0;
  const a = harness({
    deps: {
      makeView: function (opts) {
        calls++;
        if (calls === 2) throw new Error('synthetic-view-boom');
        a.o.viewOpts = opts;
        a.view.rows = String(opts.text).split('\n');
        return a.view;
      },
    },
  });
  await a.c.begin({ index: 0, el: {} });
  const out = await a.c.newParagraph();
  assert.strictEqual(out, false);
  assert.deepStrictEqual(a.c.lines(), ['- a', '- b', '', '', '']);
  assert.ok(a.reports.some(function (r) { return /live-enter-failed/.test(r.m); }));
  assert.strictEqual(a.c.isNewParagraph(), false);
  assert.strictEqual(a.c.stackSize(), 1);
});

// ── 脏判据（2026-10-29 复评 P1-1：视图里的输入也算脏）────────────────────
test('dirty 把「已输入未提交」也算进去，不只是会话与基线不同', async () => {
  const a = harness();
  await a.c.begin({ index: 0, el: {} });
  assert.strictEqual(a.c.isDirty(), false);
  a.view.rows = ['- a', '- typing'];
  assert.strictEqual(a.c.isDirty(), true);
  assert.strictEqual(a.c.fullText(), '- a\n- b');
});

// ── 常量 ────────────────────────────────────────────────────────────────
test('等高容差与提交轮数常量与设计一致', () => {
  assert.strictEqual(LC.HEIGHT_TOLERANCE, 0.5);
  assert.strictEqual(LC.MAX_COMMIT_ROUNDS, 3);
  assert.deepStrictEqual(LC.LIMITS, { maxBlockLines: 2000, maxBlockBytes: 256 * 1024 });
});
