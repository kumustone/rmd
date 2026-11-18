// `design/0047` §2.3–§2.6 的**顺序判据**：Prep→Swap、commit 协议、状态机、身份四件套。
//
// ⚠️ 这一份跑的是 `src/live/index.js::createController` —— **全部依赖注入**
//    （DOM / CM6 / IPC / 状态条都是假的），所以能在 node 里断言"谁先谁后、哪一包被丢"。
//    真 DOM 那半（离屏建视图、等高、交换）在 `main.js` 的注入实现里，观感归人工（§7.3）。
//
// ⭐ 这里抓的错**屏幕都不报错**：
//   ① 行区间差一行（改 A 块、坏 B 块）；② 旧回包覆盖新内容（"字自己退回去了"）；
//   ③ 没改动也压一条撤销（`⌘Z` 要按两次才有反应）；④ 身份不符还进了编辑态（行号指向别处）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../src/live/index.js');
const M = require('../../src/live/model.js');

/** 与 Rust `blocks.rs::KIND_NAMES` 同序（下标就是线格式里的 `kind_idx`）。 */
const KINDS = [
  'Paragraph',
  'Heading',
  'CodeBlock',
  'List',
  'BlockQuote',
  'Table',
  'HtmlBlock',
  'ThematicBreak',
  'FootnoteDefinition',
  'Other',
];

function t(key, vars) {
  if (!vars) return key;
  return (
    key +
    ' ' +
    Object.keys(vars)
      .map(function (k) {
        return k + '=' + vars[k];
      })
      .join(',')
  );
}

/**
 * 一套假依赖。`o` 可覆盖：`text` / `blocksFor(text)` / `payload` / `lossy` / `limits` /
 * `beginFails` / `renderFails` / `height` / `mountFails`（`true` 或 `(payload, n) -> boolean`）。
 */
function harness(o) {
  const opt = o || {};
  const text0 = opt.text === undefined ? 'A\n\nC' : opt.text;
  const state = {
    text: text0,
    payload: null,
    reports: [],
    begins: [],
    ends: [],
    renders: [],
    mounts: [],
    saves: [],
    swaps: [],
    /** `swap.undo()` 的**调用**次数（与既有判据同义）。 */
    unswaps: 0,
    /** ⭐ 真生效的 undo 次数。真实现 `main.js::swapLiveView` 有一个 `undone` 幂等位，
     *  ⇒ 同一个 swap 被调两次只搬一次宿主，第二次返回 `false`。判"宿主还回去几次"用这个。 */
    unswapApplied: 0,
    views: [],
    /** 对齐表的节点身份：每次挂载都换一批（`innerHTML` 整棵重建）。 */
    nodes: {},
    /** 事件顺序台账（`mount` / `unswap`）——判"先还宿主、再提交"。 */
    order: [],
    height: opt.height === undefined ? 100 : opt.height,
    elHeight: 100,
    /** 手动控制 `render_preview` 何时回包（竞态判据用）。 */
    gate: null,
    /** ⭐ 每次 `focusAt({pos})` 的落点台账（`bugs/0024`：撤销要回到操作前那一个）。 */
    carets: [],
    /** ⭐ `pendingHost(prev)` 的台账：`after` 是"插在哪一块之后"。 */
    pendingHosts: [],
    /** ⭐ `onStaleDocument` 的台账（`design/0047` §6 的"自动重载"）。 */
    stale: [],
  };

  function payloadFor(txt) {
    const n = txt.split('\n').length;
    return {
      real_path: opt.realPath || '/tmp/a.md',
      gen: opt.generation === undefined ? 7 : opt.generation,
      doc_seq: opt.docSeq === undefined ? 3 : opt.docSeq,
      line_count: n,
      // ⚠️ 拿 `html` 当"这一包是谁"的标记：整条链按**整篇文本**走，正文就是回包的身份。
      html: txt,
      toc: [],
      block_kinds: KINDS,
      blocks: opt.blocksFor ? opt.blocksFor(txt) : [[0, 1, n, 1]],
    };
  }

  /** ⚠️ 测试可以换掉它（模拟"后端回包的行数不对"）。 */
  state.payloadFor = opt.payloadFor || payloadFor;

  state.payload = opt.payload || payloadFor(text0);

  const ctrl = C.createController({
    t: t,
    report: function (m) {
      state.reports.push(String(m));
    },
    announce: function (m) {
      state.reports.push('[a11y] ' + m);
    },
    limits: opt.limits,
    beginEdit: async function (arg) {
      state.begins.push(arg);
      if (opt.beginFails) throw new Error('denied');
      if (opt.beginGate) await opt.beginGate;
      return {
        real_path: state.payload.real_path,
        // `grantText` 让判据能造"授权文本与块表的行数对不上"那一条（身份四件套）。
        text: opt.grantText === undefined ? state.text : opt.grantText,
        envelope: { bom: false, eol: opt.lossy ? 'other' : 'lf', lossy: !!opt.lossy },
      };
    },
    endEdit: async function (arg) {
      state.ends.push(arg);
    },
    renderPreview: async function (arg) {
      const n = state.renders.push(arg);
      if (opt.renderFails) throw new Error('boom');
      // ⚠️ 竞态判据要手工决定"谁先回包"：`renderGate(第几次调用)` 返回一个 Promise。
      if (opt.renderGate) {
        const g = opt.renderGate(n);
        if (g) await g;
      }
      return state.payloadFor(arg.text);
    },
    mount: function (p) {
      state.mounts.push(p);
      state.payload = p;
      // ⭐ `mountFails`：让挂载抛错（`true`＝每次都抛；函数＝`(payload, 第几次) -> boolean`）。
      //    ⚠️ 与真 `mountDocument` 同形：`#doc.innerHTML` 已经换过 ⇒ 正文是新的，
      //    但它收尾的 `noteLive → notePayload` 没跑。
      state.order.push('mount');
      if (opt.mountFails === true || (typeof opt.mountFails === 'function' && opt.mountFails(p, state.mounts.length))) {
        state.order.push('mount-failed');
        throw new Error('mount boom');
      }
      // ⭐⭐ 真 `mountDocument` 挂完正文就调 `noteLive` ⇒ `live.notePayload(payload)`
      //    （`main.js`）。⚠️ 少了这一句，夹具里"提交之后块表换新"这件事**根本不存在**，
      //    而它正是 `bugs/0017`（身份按挂载载荷比）与 `bugs/0018`（提交后 `el` 脱树）的前提。
      //    ⚠️ 顺带把"对齐表里的节点"也换一批新的：真实现是 `innerHTML` 整棵重建。
      state.nodes = {};
      ctrl.notePayload(p);
    },
    // ⭐ 对齐表查询口（`main.js::slotNode`）。⚠️ 每次挂载后**节点身份就变了**：
    //    真实现是 `#doc.innerHTML = …`，旧节点一律脱树。
    nodeOf: function (index) {
      if (!Object.prototype.hasOwnProperty.call(state.nodes, index)) {
        state.nodes[index] = { index: index, gen: state.mounts.length };
      }
      return state.nodes[index];
    },
    // ⭐ 单元格节点口（`main.js::cellNodeOf`，`design/0049`）。⚠️ 不提供它，
    //    `begin({cell})` 会在**可写性检查之前**就报 `no-node` ⇒ 下面那三条拒绝路径
    //    （`INV-CELL-05/06`）根本走不到，测试会假装在验它。
    cellNodeOf: function (index, flat) {
      return { index: index, flat: flat, cell: true };
    },
    // ⭐ `design/0047` §6 的「身份四件套不符 ⇒ 自动重载」。⚠️ **默认不注入**：
    //    老判据验的是"退回那条红字"的兜底路径，注入与否是两条不同的收场。
    onStaleDocument: opt.onStaleDocument
      ? function (a) { state.stale.push(a); }
      : undefined,
    saveDisk: async function (arg) {
      state.saves.push(arg);
    },
    makeView: function (arg) {
      const v = {
        dom: { id: 'view' },
        lines: String(arg.text).split('\n'),
        offsets: arg.lineOffset,
        /** ⭐ 光标（块内偏移）。`⌘↵` 记 `caretBefore`、撤销之后要比回来（`bugs/0024`）。 */
        caretPos: 0,
        height: function () {
          return state.height;
        },
        linesNow: function () {
          return v.lines.slice();
        },
        destroy: function () {
          v.destroyed = true;
        },
        caret: function () {
          return v.caretPos;
        },
        /**
         * ⭐ 块内选区（`design/0059` 阶段 A：事务载荷的"选前/选后"）。
         * ⚠️ 与真 `main.js` 同形：给 `{anchor, head}`，**保留方向**；测试可以改 `v.sel`。
         */
        selection: function () {
          return v.sel ? { anchor: v.sel.anchor, head: v.sel.head } : { anchor: v.caretPos, head: v.caretPos };
        },
        focusAt: function (p) {
          v.focused = true;
          if (p && Number.isInteger(p.pos)) v.caretPos = p.pos;
          state.carets.push(p && Number.isInteger(p.pos) ? p.pos : null);
        },
      };
      state.views.push(v);
      return {
        dom: v.dom,
        lines: v.linesNow,
        height: v.height,
        destroy: v.destroy,
        caret: v.caret,
        selection: v.selection,
        focusAt: v.focusAt,
      };
    },
    swap: function (arg) {
      state.swaps.push({ el: arg.el, host: arg.host });
      let undone = false;
      return {
        undo: function () {
          state.unswaps++;
          // ⚠️ 真实现有 `undone` 幂等位（`main.js::swapLiveView`）⇒ 第二次调用什么都不做。
          if (undone) return false;
          undone = true;
          state.unswapApplied++;
          state.order.push('unswap');
          return true;
        },
      };
    },
    heightOf: function () {
      return state.elHeight;
    },
    // ⭐ 「`⌘↵` 新起的一段」的临时宿主（`main.js::pendingHost`）。⚠️ 真实现是往 `#doc` 里
    //    插一个 `<p class="rmd-pending-block">`；这里只要一个**可当 `el` 用**的对象 ＋
    //    记下"插在哪一块之后"（连续两次 `⌘↵` 的顺序判据靠它）。
    pendingHost: function (prev) {
      const host = { pending: true, after: prev ? prev.index : null, parentNode: null };
      state.pendingHosts.push(host);
      return host;
    },
  });

  ctrl.notePayload(state.payload);

  return {
    ctrl: ctrl,
    state: state,
    /** 改活动视图里的内容（模拟用户打字）。 */
    type: function (lineIndex, text) {
      const v = state.views[state.views.length - 1];
      v.lines[lineIndex] = text;
    },
    /** 把光标摆到块内第 `pos` 个偏移（真 CM6 里由点击 / 方向键做）。 */
    setCaret: function (pos) {
      state.views[state.views.length - 1].caretPos = pos;
    },
    /** 会话此刻的正文：**最后一次提交进 `render_preview` 的那一份**（没提交过就是夹具原文）。 */
    text: function () {
      return state.renders.length
        ? state.renders[state.renders.length - 1].text
        : text0;
    },
    block: function (index) {
      return ctrl.blocks().filter(function (b) {
        return b.index === index;
      })[0];
    },
    el: {},
    payloadFor: payloadFor,
  };
}

// ── 进入：Prep → Swap ─────────────────────────────────────────────────────

test('进入：Prep 齐了才 Swap，成功后进 `editing` 并挂上视图', async function () {
  const h = harness();
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(h.state.begins.length, 1);
  assert.strictEqual(h.state.swaps.length, 1, 'Swap 只做一次');
  assert.strictEqual(h.ctrl.state(), 'editing');
  assert.strictEqual(h.ctrl.activeIndex(), 0);
  assert.deepStrictEqual(h.ctrl.envelope(), { bom: false, eol: 'lf', lossy: false });
});

test('⭐ 不可编辑的块：⛔ 连 `begin_edit` 都不调（⛔ 不为一次点击申请写授权）', async function () {
  const h = harness({ blocksFor: function () { return [[2, 1, 3, 0]]; } }); // CodeBlock，editable=0
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.state.begins.length, 0);
  assert.ok(h.state.reports[0].indexOf('status.live-not-editable') >= 0, h.state.reports[0]);
});

test('块表有问题（`issues` 非空）⇒ ⛔ 不进编辑态（`INV-LIVE-06`）', async function () {
  const h = harness({
    payload: { real_path: '/tmp/a.md', gen: 7, doc_seq: 3, line_count: 3, block_kinds: KINDS, blocks: null },
  });
  const r = await h.ctrl.begin({ index: 0, block: { index: 0, from: 0, to: 1, editable: true }, el: h.el });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.state.begins.length, 0);
});

/**
 * ⭐⭐ `design/0047` §6 的那一行恢复要求：
 * 「身份四件套不符（换文档/重载/行数变了）⇒ ⛔ 不进编辑态｜用户可见『正文已变化，重新载入中』｜**自动重载**」。
 *
 * ⚠️⚠️ 为什么必须单独钉一条（2026-11-03 用户实测）：实现此前只做了前半句——一条红字
 *    「正文在打开后被改过（行数 275 → 148）⇒ 就地编辑没有开始」，**正文一点不动**。
 *    用户看到的是"我点它，它告诉我文件改过了，然后就没了"，得自己去菜单里重载。
 *    ⇒ 判据有两半：① `onStaleDocument` **被叫到**（重载真的会发生）；
 *    ② 授权**归还**了、一个视图都没建（⛔ 不能拿着写授权去重载）。
 */
test('⭐⭐ 身份不符 ⇒ 请上层**自动重载**（`design/0047` §6），⛔ 只留一条红字', async function () {
  // 块表说整篇 3 行，而 `begin_edit` 给的文本有 4 行 ⇒ 磁盘在打开之后被改过。
  const h = harness({ grantText: 'A\n\nC\nD', onStaleDocument: true });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'identity');
  assert.strictEqual(h.state.stale.length, 1, '必须请上层重载（⛔ 只报一句就完事）');
  assert.ok(
    h.state.reports.some(function (m) { return m.indexOf('status.live-reloading') >= 0; }),
    h.state.reports.join('|')
  );
  assert.strictEqual(h.state.ends.length, 1, '写授权必须归还');
  assert.strictEqual(h.state.views.length, 0, '⛔ 一个视图都不许建');
  assert.strictEqual(h.ctrl.state(), 'viewing');
});

test('兜底：没有注入重载口 ⇒ 仍报那条红字（⛔ 不假装重载了）', async function () {
  const h = harness({ grantText: 'A\n\nC\nD' });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(r.ok, false);
  assert.ok(h.state.reports.join('|').indexOf('status.live-identity') >= 0, h.state.reports.join('|'));
  assert.strictEqual(h.state.stale.length, 0);
});

// ── 表格单元格入口（`design/0049`）：一条正对照 + 三条**拒绝**路径 ────────────
//
// ⚠️⚠️ 为什么必须单开这一组：离屏闸门（`make probe-live-block` 的 `Q` 段）跑的是
//    「点得进去、改得对」，⛔ 一条都不跑「这一格**不许**进去」。而拒绝错了的后果是
//    **写坏别的格子**（`INV-CELL-05/06`），屏幕上只表现为"没进去"或"进错了格"——
//    没有任何报错，也没有任何既有判据会红。
//
// ⭐ 三条拒绝路径的**共同判据**是 `begins.length === 0`：连写授权都不许申请
//    （与上面那条「不可编辑的块」同一个口径），⛔ 不是"申请了再放弃"。

/**
 * 一张表格夹具：第 3 行是一行两格（`| c | d |` ⇒ 列区间 `[2,3)` / `[6,7)`）。
 * ⚠️ `Block` 的种类下标必须是 `Table`（`KINDS[5]`），块级 `editable = 0`
 *    （`design/0049` §3：格子是**另一条入口**，⛔ 不是把 `Table` 挪进块级白名单）。
 * @param {Array|null} rows 线格式 `[[line, from, to, writable], …]`；`null` ⇒ 载荷干脆没有 `table_cells`
 */
function 表格载荷(rows) {
  const p = {
    real_path: '/tmp/a.md',
    gen: 7,
    doc_seq: 3,
    line_count: 3,
    html: 'x',
    toc: [],
    block_kinds: KINDS,
    blocks: [[5, 1, 3, 0]],
  };
  if (rows) p.table_cells = [[0, rows]];
  return p;
}

test('⭐ 正对照：可写的格子进得去（证明下面三条拒绝不是"这条路本来就进不去"）', async function () {
  const h = harness({ text: '| a | b |\n|---|---|\n| c | d |', payload: 表格载荷([[3, 2, 3, 1], [3, 6, 7, 1]]) });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el, cell: { flat: 0 } });
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(h.state.begins.length, 1);
  assert.strictEqual(h.state.views[0].lines[0], 'c', '视图里就是那一格的源码（⛔ 不是整行）');
});

test('⭐ `INV-CELL-05`：`writable = 0` 的格子 ⇒ 拒绝，⛔ 连 `begin_edit` 都不调', async function () {
  // 自动补出来的空列（`blocks.rs::cell_span` 把它标成不可写）：区间落在最后一个 `|` 之后。
  const h = harness({ text: '| a | b |\n|---|---|\n| c | d |', payload: 表格载荷([[3, 2, 3, 1], [3, 6, 7, 0]]) });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el, cell: { flat: 1 } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.state.begins.length, 0, '⛔ 不为一次注定失败的点击申请写授权');
  assert.ok(h.state.reports[0].indexOf('status.cell-locked') >= 0, h.state.reports[0]);
});

test('⭐ `INV-CELL-06`：载荷里没有这一格（与 DOM 对不上）⇒ 拒绝，⛔ 不部分配对', async function () {
  const h = harness({ text: '| a | b |\n|---|---|\n| c | d |', payload: 表格载荷([[3, 2, 3, 1], [3, 6, 7, 1]]) });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el, cell: { flat: 9 } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.state.begins.length, 0);
  assert.ok(h.state.reports[0].indexOf('status.cell-pairing') >= 0, h.state.reports[0]);
});

test('⭐ 载荷里根本没有 `table_cells`（老后端）⇒ 如实告知，⛔ 不猜一个位置', async function () {
  const h = harness({ text: '| a | b |\n|---|---|\n| c | d |', payload: 表格载荷(null) });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el, cell: { flat: 0 } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.state.begins.length, 0);
  assert.ok(h.state.reports[0].indexOf('status.cell-unavailable') >= 0, h.state.reports[0]);
});

test('⭐ 身份四件套之 `line_count`：授权文本的行数对不上 ⇒ 拒绝并**归还授权**', async function () {
  // 块表说整篇 3 行，而 `begin_edit` 给的文本只有 2 行 ⇒ 行号已经陈旧。
  const h = harness({ grantText: 'A\nB' });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.state.swaps.length, 0, '⛔ 身份不符还交换 DOM');
  assert.deepStrictEqual(h.state.ends, [{ discard: true }], '授权要还回去');
  assert.ok(h.state.reports[0].indexOf('status.live-identity') >= 0, h.state.reports[0]);
});

test('行尾不统一（`lossy`）⇒ 拒绝，且 ⛔ 不交换', async function () {
  const h = harness({ lossy: true });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.state.swaps.length, 0);
  assert.ok(h.state.reports[0].indexOf('status.live-eol') >= 0, h.state.reports[0]);
});

// ⭐⭐ `design/0052` U6 起这两条**翻转了方向**（`INV-KERNEL-05`：块永远进得去）。
//    U6 之前是"几何对不上 ⇒ 回滚、不上屏、不交换"，代价是高过一屏的块**永远点不进去**
//    （CM6 只测量视口内的行 ⇒ 恒定 +20.141 px）。用户 2026-10-27 拍板"体验为先"。
//    ⚠️ 但"变矮"仍然要报：那是排版丢东西（`h1` −7 px 那一族），状态条是用户唯一看得见的那一处。
//
// ⛔⛔ **2026-11-09 收口：下面两条只描述"当前实现"，⛔ 不是合规形态。**
//    `design/0047` §5 `INV-LIVE-04`（2026-11-09 版）要求**进入瞬间逐像素不动**，
//    "变高只记账"与"变矮两档都放行"都是**缺陷**（`bugs/0298` 一族）。
//    ⇒ 它们是**特征化测试**（把现状钉住，防止重构时悄悄改掉别的）；修好之后这两条必须
//      跟着翻转成"不进编辑态 / 回滚并说明"，⛔ 不许拿"测试是绿的"当成产品对。
test('⚠️ 现状（缺陷）：变高**只记账、⛔ 不拦人**：视图上屏、交换照做、状态条不弹', async function () {
  // ⚠️ 这就是 bigblock 的形态（CM6 只测量视口内的行 ⇒ 高过一屏的块恒定 +20.141 px）。
  const h = harness({ height: 140 });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(r.ok, true, 'U6 之后几何差**不许**阻断进入');
  assert.strictEqual(h.state.swaps.length, 1, '交换照做');
  assert.ok(!h.state.views[0].destroyed, '⛔ 不许销毁视图');
  assert.strictEqual(h.state.reports.join('|').indexOf('status.live-short'), -1,
    '变高**不逐条弹状态条**（每块都弹会淹掉真错误）：' + h.state.reports.join('|'));
});

test('⚠️ 现状（缺陷）：变矮阈值 0.5 px（0.5 不吭声、0.6 报一句；**两档都放行**）', async function () {
  const ok = harness({ height: 99.5 });
  const a = await ok.ctrl.begin({ index: 0, block: ok.block(0), el: ok.el });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(ok.state.reports.join('|').indexOf('status.live-short'), -1,
    '阈值以内不该报：' + ok.state.reports.join('|'));

  const bad = harness({ height: 99.4 });
  const b = await bad.ctrl.begin({ index: 0, block: bad.block(0), el: bad.el });
  assert.strictEqual(b.ok, true, '⚠️ 只告警，⛔ 不放回原样');
  assert.strictEqual(bad.state.swaps.length, 1, '变矮也照常上屏');
  assert.ok(bad.state.reports.join('|').indexOf('status.live-short') >= 0,
    bad.state.reports.join('|'));
});

test('`begin_edit` 拒绝 ⇒ 停在 Viewing，一行说明（⛔ 不抛到调用方）', async function () {
  const h = harness({ beginFails: true });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.ctrl.state(), 'viewing');
  assert.ok(h.state.reports[0].indexOf('status.live-enter-failed') >= 0, h.state.reports[0]);
});

test('⭐ Prep 被打断（期间又点了一次）：先那次自己作废，⛔ 不交换 DOM', async function () {
  // ⚠️ 先给一个空实现（`checkJs` 下 `let release;` 的类型是 `undefined`，
  //    后面那句 `release()` 会被判「不能调用可能是 undefined 的值」）。真值仍由执行器覆盖。
  /** @type {(value?: any) => void} */
  let release = function () {};
  const gate = new Promise(function (res) {
    release = res;
  });
  const h = harness({ beginGate: gate });
  const first = h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  // 第一次还卡在 `begin_edit` 里，用户又点了同一块 ⇒ `enterSeq` 往前推。
  const second = h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a.ok, false, '被打断的那次必须自己放弃');
  assert.strictEqual(b.ok, true);
  assert.strictEqual(h.state.swaps.length, 1, '⭐ 只有后一次交换了 DOM');
  // 被打断那次也要把写授权还回去（它已经拿到过 grant）
  assert.strictEqual(h.state.ends.length, 1);
  assert.deepStrictEqual(h.state.ends[0], { discard: true });
});

// ── 提交（§2.4）──────────────────────────────────────────────────────────

test('⭐ 提交只动**本块**的行，区间外一个字节不动', async function () {
  const h = harness({ text: 'A\n\nC', blocksFor: function () { return [[0, 1, 1, 1], [0, 3, 3, 1]]; } });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'AAA');
  await h.ctrl.commit();
  assert.strictEqual(h.state.renders.length, 1);
  const sent = h.state.renders[0].text;
  assert.strictEqual(sent, 'AAA\n\nC', '第二行之后的空行与 C 必须原样');
  assert.strictEqual(h.state.mounts.length, 1, '提交点只走一次');
});

test('没有改动 ⇒ ⛔ 不渲染、⛔ 不压撤销（`⌘Z` 不该按两次才动）', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  // ⭐ `design/0054`：返回值是**结构化结果**（`{committed, failed, why}`），⛔ 不再是布尔。
  assert.deepStrictEqual(await h.ctrl.commit(), { committed: false, failed: false, why: '' });
  assert.strictEqual(h.state.renders.length, 0);
  assert.strictEqual(h.ctrl.stackSize(), 0);
});

test('提交后块的行区间跟着变（多打两行 ⇒ 后面的块不会被顶歪）', async function () {
  const h = harness({ text: 'A\n\nC', blocksFor: function () { return [[0, 1, 1, 1], [0, 3, 3, 1]]; } });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  const v = h.state.views[0];
  v.lines = ['A1', 'A2'];
  await h.ctrl.commit();
  const sent = h.state.renders[0].text;
  assert.strictEqual(sent, 'A1\nA2\n\nC', '第三行仍是空行、第四行仍是 C');
  assert.strictEqual(h.state.mounts[0].line_count, 4);
  // 再提交一次（视图里的区间已变成 1–2 行）
  v.lines = ['A1', 'A2x'];
  await h.ctrl.commit();
  assert.strictEqual(h.state.renders[1].text, 'A1\nA2x\n\nC');
});

// ── 事务载荷（`design/0059` 阶段 A）────────────────────────────────────────
//
// ⭐ 这一组判的是「载荷里的每一项**真的**描述了这次变更」，⛔ 不是"字段存在"。
//    最容易自欺的两处：
//    ① 选后选区抄一份选前（同义反复 ⇒ 调用方永远读到自己进去时的那个）；
//    ② 修订沿用 T0 基线（成功载荷里 `fullText` 是新文本、`revision` 却指向旧文本）。

test('⭐ 事务载荷：选前/选后分开取、修订描述载荷文本、三个维度如实声明', async function () {
  /** @type {null | ((value?: any) => void)} */
  let release = null;
  const h = harness({
    // 两块夹具：第一块只占第 1 行 ⇒ 正文的后两行必须原样保留（区间不许外溢）。
    blocksFor: function () {
      return [[0, 1, 1, 1], [0, 3, 3, 1]];
    },
    // ⚠️ 卡在**异步段**（`render_preview`）里：给"提交期间光标还动了"留出可观测的窗口。
    renderGate: function () {
      return new Promise(function (res) {
        release = res;
      });
    },
  });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  const v = h.state.views[0];

  // 选前：**反向**选区（`anchor > head`）——方向必须原样保留，⛔ 不许归一成 from/to。
  v.sel = { anchor: 1, head: 0 };
  v.lines = ['A1'];
  const pending = h.ctrl.commit();
  await new Promise(function (r) {
    setTimeout(r, 0);
  });

  // 异步段里用户把光标挪了（⛔ 没有发起第二次提交）。
  v.sel = { anchor: 3, head: 2 };
  // ⚠️ 走到这里说明 `render_preview` 已经真的被调用并卡住了；没卡住就是夹具坏了，
  //    ⛔ 不许把"闸门没生效"读成"提交本来就这样"。
  if (!release) throw new Error('前提：render_preview 必须卡在闸门里');
  release();
  const out = await pending;
  assert.strictEqual(out.committed, true);

  const tx = h.ctrl.lastTransaction();
  assert.strictEqual(tx.status, 'committed');
  // 三个维度分开声明（`design/0059` §2.1）：⛔ 不混装成 `source`。
  assert.strictEqual(tx.operation, 'edit');
  assert.strictEqual(tx.objectKind, 'block');
  assert.strictEqual(tx.mode, 'live');

  // ① 选前 = 发起那一刻（反向）。
  assert.deepStrictEqual(
    { anchor: tx.selectionBefore.anchor, head: tx.selectionBefore.head },
    { anchor: 1, head: 0 }
  );
  // ② 选后 = **发布那一刻**从活动视图取的（⛔ 不是把选前抄一遍）。
  assert.deepStrictEqual(
    { anchor: tx.selectionAfter.anchor, head: tx.selectionAfter.head },
    { anchor: 3, head: 2 }
  );
  assert.strictEqual(tx.selectionAfter.space, 'block', '块内偏移的空间必须标清');
  assert.strictEqual(
    tx.selectionAfter.revision.commitSeq,
    tx.revision.commitSeq,
    '选后选区与载荷正文必须属于同一修订'
  );

  // ③ 修订描述**载荷里这份文本**：发布让 `commitSeq` 前进了一次，
  //    而选前选区记的是**发起时**那一版 ⇒ 两者必须正好差一。
  assert.strictEqual(tx.revision.commitSeq, tx.selectionBefore.revision.commitSeq + 1);
  assert.strictEqual(tx.fullText, 'A1\n\nC');
  assert.strictEqual(tx.lineCount, 3);
  assert.strictEqual(tx.lines.length, 3);
});

test('⭐ 事务载荷：`unchanged` 的选后 = 选前（真值没动），⛔ 不冒充一次提交', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  const v = h.state.views[0];
  v.sel = { anchor: 2, head: 2 };
  const out = await h.ctrl.commit();
  assert.strictEqual(out.committed, false);
  const tx = h.ctrl.lastTransaction();
  assert.strictEqual(tx.status, 'unchanged');
  assert.deepStrictEqual(tx.selectionAfter, tx.selectionBefore);
  assert.strictEqual(h.state.renders.length, 0, '⛔ 没改动还发渲染');
  assert.strictEqual(tx.revision.commitSeq, 0, '修订仍停在基线那一版');
});

test('⭐ 身份复核失败（回包行数不对）⇒ ⛔ 不 mount，报「结构不符」', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  // 后端回过一个"行数对不上"的包：`line_count` 是四件套里最阴的那一条。
  const good = h.state.payloadFor;
  h.state.payloadFor = function (txt) {
    const p = good(txt);
    p.line_count = p.line_count + 5;
    return p;
  };
  h.type(0, 'Q');
  const out = await h.ctrl.commit();
  // ⭐ `design/0054` 起返回结构化结果：身份不符是**失败**（`failed: true`），⛔ 不是"无改动"。
  assert.strictEqual(out.committed, false);
  assert.strictEqual(out.failed, true, '身份不符必须报成失败，⛔ 不许退化成"没改"');
  assert.strictEqual(h.state.mounts.length, 0, '⛔ 身份不符还提交上屏');
  assert.ok(h.state.reports.join('|').indexOf('status.live-align') >= 0, h.state.reports.join('|'));
});

test('`acceptReply`：四个身份逐条都能拦住（含"看起来一切正常"的 `line_count`）', function () {
  const id = M.identity({ realPath: '/a.md', generation: 1, docSeq: 2, lineCount: 3, commitSeq: 0 });
  const good = { real_path: '/a.md', generation: 1, doc_seq: 2, line_count: 3 };
  assert.strictEqual(M.acceptReply(id, good).ok, true);
  assert.strictEqual(M.acceptReply(id, Object.assign({}, good, { line_count: 4 })).ok, false);
  assert.strictEqual(M.acceptReply(id, Object.assign({}, good, { doc_seq: 9 })).ok, false);
  assert.strictEqual(M.acceptReply(id, Object.assign({}, good, { real_path: '/b.md' })).ok, false);
  assert.strictEqual(M.acceptReply(id, Object.assign({}, good, { generation: 2 })).ok, false);
});

test('⭐ 渲染竞态：先发后到的旧回包**必须被丢**（`mount` 只发生一次）', async function () {
  const gates = [];
  const h = harness({
    renderGate: function () {
      return new Promise(function (res) {
        gates.push(res);
      });
    },
  });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });

  // 两次提交；第二次的包后发但**先回**（`req` 更大 ⇒ 内容更新）。
  h.type(0, 'B');
  const first = h.ctrl.commit();
  h.type(0, 'C');
  const second = h.ctrl.commit();
  await new Promise(function (r) {
    setTimeout(r, 0);
  });
  assert.strictEqual(gates.length, 2, '两次提交各发了一次渲染');

  gates[1](); // 后发先回
  await second;
  gates[0](); // 先发后回 ⇒ 必须丢
  await first;

  assert.strictEqual(h.state.mounts.length, 1, '⭐ 旧回包不许再挂一次');
  assert.strictEqual(h.state.mounts[0].html, 'C\n\nC', '挂上去的是最新那份');
});

// ── 退出 ─────────────────────────────────────────────────────────────────

test('退出（未改）：不渲染、恢复 DOM、销毁视图、**丢弃**授权', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  const r = await h.ctrl.leave({});
  assert.strictEqual(r.committed, false);
  assert.strictEqual(h.state.renders.length, 0);
  assert.strictEqual(h.state.unswaps, 1);
  assert.strictEqual(h.state.views[0].destroyed, true);
  assert.deepStrictEqual(h.state.ends, [{ discard: true }]);
  assert.strictEqual(h.ctrl.state(), 'viewing');
});

test('退出（已改）：先提交再拆视图（顺序反了会丢最后一次输入）', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Z');
  const r = await h.ctrl.leave({});
  assert.strictEqual(r.committed, true);
  assert.strictEqual(h.state.renders[0].text, 'Z\n\nC');
  assert.deepStrictEqual(h.state.ends, [{ discard: false }]);
  // ⚠️ ⭐ `design/0054` 起是**两次** `unswap`，各有各的活：
  //    ① 发布段里那一次 —— 摘掉旧宿主，才能在它原来的位置挂重渲出来的节点（`bugs/0018`）；
  //    ② 退出时这一次 —— 挂着的是 `reseat()` 之后**新的**那一份宿主（真机上由
  //       `main.js::reseatLive` 换掉 `a.swap`），销毁视图之前要把它也还回去。
  assert.strictEqual(h.state.unswaps, 2);
});

test('`discard: true` ⇒ ⛔ 不提交（调用方已经过了 `0012` 的脏提示闸）', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Z');
  const r = await h.ctrl.leave({ discard: true });
  assert.strictEqual(r.committed, false);
  assert.strictEqual(h.state.renders.length, 0);
  assert.deepStrictEqual(h.state.ends, [{ discard: true }]);
});

test('点另一块：先把上一块提交掉（⛔ 不静默丢），再进新块', async function () {
  const h = harness({ text: 'A\n\nC', blocksFor: function () { return [[0, 1, 1, 1], [0, 3, 3, 1]]; } });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'AAA');
  const r = await h.ctrl.begin({ index: 1, block: h.block(1), el: h.el });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.state.renders.length, 1, '第一次提交发生了');
  assert.strictEqual(h.state.renders[0].text, 'AAA\n\nC');
  assert.strictEqual(h.state.swaps.length, 2, '新块也交换了');
  assert.strictEqual(h.ctrl.activeIndex(), 1);
});

// ── `bugs/0018`：提交会整篇重渲 ⇒ 调用方手里的块表 / 节点全部过期 ──────────────

/** ⚠️ 块表**跟着文本变**（首行一块，其余整段一块）——`blocksFor` 吃的是提交后的全文。 */
function tailBlock(text) {
  const n = text.split('\n').length;
  return [[0, 1, 1, 1], [0, n, n, 1]];
}

test('⭐⭐ 提交之后点另一块：行区间从**新表**取（`bugs/0018`）', async function () {
  // 复现：块 0 从 1 行改成 2 行（未保存）⇒ 点块 1。
  // 修复前：`onLiveDocDown` 手里那份 `block` 是**提交前**的表（块 1 在第 3 行），
  //   而提交已经把它推到了第 4 行 ⇒ 切出来的是**空格那一行**，
  //   屏幕上表现为"点这块，进去的是别处的内容"，而且切得动、不报错。
  const h = harness({ text: 'A\n\nC', blocksFor: tailBlock });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.state.views[0].lines = ['A', 'A2'];
  const stale = h.block(1); // ⚠️ **提交前**取的：`startLine` 是 3
  assert.strictEqual(stale.startLine, 3, '前提：旧表里块 1 在第 3 行');

  const r = await h.ctrl.begin({ index: 1, block: stale, el: h.el });
  assert.strictEqual(r.ok, true, h.state.reports.join('|'));
  assert.deepStrictEqual(h.state.views[1].lines, ['C'], '进去的必须是提交后那一行');
  assert.strictEqual(h.state.views[1].offsets, 3, '行偏移同样按新表算（0-based 第 4 行）');
});

test('⭐⭐ 提交之后点另一块：节点也从**新树**取（`bugs/0018` 的另一面）', async function () {
  // 修复前：`el` 是调用方在**重渲之前**抓的节点，`#doc.innerHTML` 之后它已经脱树
  //   ⇒ `getComputedStyle` 读不到盒子、`heightOf` 量成 0、`parentNode` 是 null。
  const h = harness({ text: 'A\n\nC', blocksFor: tailBlock });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.state.views[0].lines = ['A', 'A2'];
  const r = await h.ctrl.begin({ index: 1, block: h.block(1), el: h.el });
  assert.strictEqual(r.ok, true, h.state.reports.join('|'));
  assert.notStrictEqual(h.state.swaps[1].el, h.el, '⛔ 不许拿重渲之前那个脱树节点去 swap');
  assert.strictEqual(h.state.swaps[1].el, h.state.nodes[1], 'swap 的节点就是对齐表里那个新的');
});

test('⭐⭐ 退出时**先把宿主还回去、再提交**（`bugs/0018` 的顺序面）', async function () {
  // 反了会怎样：提交 ⇒ `#doc.innerHTML` 整棵换掉，而 `swap.undo()` 记着的 `parent`
  //   是 `#doc` 自己（它不随 innerHTML 消失）、`next` 已脱树 ⇒ 走 `appendChild` 分支，
  //   把**刚才那一块的旧节点**追加到文末 —— 文末凭空多出一段一模一样的文字。
  const h = harness({ text: 'A\n\nC', blocksFor: tailBlock });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.state.views[0].lines = ['A', 'A2'];
  const r = await h.ctrl.leave({});
  assert.strictEqual(r.committed, true, '前提：这次退出真的产生了提交（否则不重渲，顺序无从谈起）');
  // ⭐ `design/0054`：发布段里的 `unswap` 仍必须排在 `mount` 之前（`bugs/0018` 的原始判据）；
  //    ③ 那一次是退出时还 `reseat()` 之后那份新宿主的（见上一条的说明）。
  assert.deepStrictEqual(
    h.state.order.slice(0, 2),
    ['unswap', 'mount'],
    'unswap 必须排在 mount 之前'
  );
});

// ── 保存 / 撤销 ───────────────────────────────────────────────────────────

test('⭐⭐ 提交一块（行数变了）之后，⛔ 不按保存也进得去下一块（`bugs/0017`）', async function () {
  // 复现：进入 → 多打一行 → 退出（提交，**磁盘还没动**）→ 再点另一块。
  // 修复前：`ident.lineCount` 被 `render_preview` 那份**缓冲**载荷刷成了 4，
  //   而 `begin_edit` 给的还是磁盘那份 3 行 ⇒ 判成"正文在打开后被改过" ⇒
  //   **之后每一块都进不去**，报的还是用户自己的改动是外部改动。
  const h = harness({ text: 'A\n\nC', blocksFor: function () { return [[0, 1, 1, 1], [0, 3, 3, 1]]; } });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.state.views[0].lines = ['A', 'A2']; // ⚠️ 整块换掉，⛔ 别用 `type()`（那是单行替换）
  await h.ctrl.leave({});
  assert.strictEqual(h.state.saves.length, 0, '前提：提交 ≠ 保存，磁盘一个字节都没动');

  const r = await h.ctrl.begin({ index: 1, block: h.block(1), el: h.el });
  assert.strictEqual(r.ok, true, h.state.reports.join('|'));
  assert.strictEqual(
    h.state.reports.join('|').indexOf('status.live-identity'),
    -1,
    '⛔ 不许再把用户自己的改动报成外部改动'
  );
});

test('⭐⭐ 磁盘真的被外部改过 ⇒ 仍然拒绝（上一条的对称面，⛔ 别把闸门放没了）', async function () {
  const h = harness({ text: 'A\n\nC', blocksFor: function () { return [[0, 1, 1, 1], [0, 3, 3, 1]]; } });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  await h.ctrl.leave({}); // 没改动 ⇒ 不提交，磁盘仍是 3 行
  // 退出之后文件被别人改成了 5 行：`begin_edit` 下次会给这份。
  h.state.text = 'A\n\nC\nD\nE';
  const r = await h.ctrl.begin({ index: 1, block: h.block(1), el: h.el });
  assert.strictEqual(r.ok, false);
  assert.ok(h.state.reports.join('|').indexOf('status.live-identity') >= 0, h.state.reports.join('|'));
});

test('⭐⭐ 提交之后（未保存）：块内容从**会话**取，⛔ 不从磁盘取', async function () {
  // 修复前：`begin()` 按**缓冲**的行区间去切**磁盘**文本 ⇒ 切出来是别的文字（或空的）。
  const h = harness({
    text: 'A\n\nC',
    blocksFor: function (txt) {
      const n = txt.split('\n').length;
      return [[0, 1, 1, 1], [0, n, n, 1]]; // 最后一行
    },
  });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.state.views[0].lines = ['A', 'A2'];
  await h.ctrl.leave({}); // 提交成 'A\nA2\n\nC'（4 行）
  // 新块表说它是第 4 行；磁盘只有 3 行 ⇒ 老代码切出空数组。
  const r = await h.ctrl.begin({ index: 1, block: h.block(1), el: h.el });
  assert.strictEqual(r.ok, true, h.state.reports.join('|'));
  assert.deepStrictEqual(h.state.views[1].lines, ['C'], '进去的必须是会话里那一行');
  assert.strictEqual(h.state.views[1].offsets, 3, '行偏移同样按会话算');
});

test('⭐ 提交 ≠ 保存：`commit` 之后磁盘一个字节都没动', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Q');
  await h.ctrl.commit();
  assert.strictEqual(h.state.saves.length, 0, '提交不写盘');
  assert.strictEqual(h.ctrl.isDirty(), true);
});

test('`save()`：先提交当前块，再把 `fullText` ＋ 信封交给写盘；写完不再脏', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Q');
  assert.strictEqual(await h.ctrl.save(), true);
  assert.strictEqual(h.state.saves.length, 1);
  assert.strictEqual(h.state.saves[0].text, 'Q\n\nC');
  assert.deepStrictEqual(h.state.saves[0].envelope, { bom: false, eol: 'lf', lossy: false });
  assert.strictEqual(h.ctrl.isDirty(), false);
  // 没改再存 ⇒ ⛔ 不重复写盘
  assert.strictEqual(await h.ctrl.save(), true);
  assert.strictEqual(h.state.saves.length, 1);
});

test('⭐⭐ 发布段挂载炸了之后**怎么退出**：`leave()` 报失败、视图活着；`discard` 才干净收场', async function () {
  // 出处：`docs/reviews/2026-10-29-前端编辑内核-长跑走查.md` N2。
  // "回滚 ＋ 拒存"那一头已经由 `live-verify.test.js` ④ 钉住；这条补**恢复链的另一头**：
  // `swap.undo()` 已经把原节点放回 `#doc`、把 host 摘了下来，而 `a.detached` 被退回
  // 发起前那份（`false`）⇒ 状态说"宿主还在树里"，实际不在。⇒ 退出这条路必须自己走通，
  // 而且授权要还**恰好一次**（漏还＝`design/0012` 的写授权留在后端；多还＝`end_edit` 记账错）。
  const h = harness({ mountFails: true }); // 每一次挂载都炸 ⇒ 这一趟永远换不上屏
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Z');

  const left = await h.ctrl.leave({});
  assert.deepStrictEqual(
    left,
    // ⭐ `pending: true`（`design/0058` §2.2）：失败时视图里**还有没提交的字**，
    //    调用方（切文档 / 关窗口）必须能读出来，⛔ 不能只看到一句"失败"。
    { ok: false, committed: false, failed: true, why: 'mount boom', pending: true },
    '⛔ 挂载失败不许被读成"没改动、退出成功"'
  );
  assert.strictEqual(h.ctrl.state(), 'editing', '失败之后仍留在编辑态（⛔ 不许静默收场）');
  assert.strictEqual(h.state.views[0].destroyed, undefined, '视图必须活着——那是用户唯一那份输入');
  assert.strictEqual(h.state.ends.length, 0, '还握着写授权 ⇒ ⛔ 不许还');
  assert.strictEqual(h.state.saves.length, 0, '磁盘一个字节都没动');
  assert.strictEqual(h.ctrl.isDirty(), true);
  assert.ok(
    h.state.reports.join('|').indexOf('status.live-publish-failed') >= 0,
    '状态条要报发布失败：' + h.state.reports.join('|')
  );

  // 用户选择放弃 ⇒ 这才许拆。⚠️ 宿主**恰好还回去一次**：发布段那次已经生效，
  // 退出时这一次撞在 `undone` 幂等位上（真实现同此）⇒ 调用 2 次、生效 1 次。
  assert.deepStrictEqual(await h.ctrl.leave({ discard: true }), { ok: true, committed: false });
  assert.strictEqual(h.ctrl.state(), 'viewing');
  assert.strictEqual(h.state.views[0].destroyed, true, '放弃了才许销毁视图');
  assert.deepStrictEqual(h.state.ends, [{ discard: true }], '授权恰好还一次');
  assert.strictEqual(h.state.unswaps, 2, '调用两次（发布段一次 ＋ 退出一次）');
  assert.strictEqual(h.state.unswapApplied, 1, '生效一次（幂等位守住，⛔ 不把节点搬第二次）');
});

test('⭐ 撤销的**两层边界**：编辑态 ⛔ 不接管 `⌘Z`（那是 CM6 的块内历史）', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(await h.ctrl.undo(), false);
  assert.strictEqual(h.state.renders.length, 0);
});

test('回到 Viewing 后 `⌘Z` 撤最近一次提交（走同一条渲染提交）', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Q');
  await h.ctrl.leave({});
  assert.strictEqual(h.ctrl.canUndo(), true);
  assert.strictEqual(h.ctrl.fullText(), 'Q\n\nC');
  assert.strictEqual(await h.ctrl.undo(), true);
  assert.strictEqual(h.state.renders[h.state.renders.length - 1].text, 'A\n\nC', '内容回到提交前');
  assert.strictEqual(h.ctrl.canUndo(), false);
  assert.ok(h.state.reports.join('|').indexOf('status.live-undo') >= 0);
});

// ── 重做（`bugs/0020` §8，2026-11-02）────────────────────────────────────

test('⭐ `⇧⌘Z` 重做最近一次撤销：内容回到提交后那份，⛔ 不动磁盘', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Q');
  await h.ctrl.leave({});
  assert.strictEqual(h.ctrl.canRedo(), false, '没撤销过 ⇒ 没有可重做的');
  assert.strictEqual(await h.ctrl.undo(), true);
  assert.strictEqual(h.ctrl.canRedo(), true);
  assert.strictEqual(await h.ctrl.redo(), true);
  assert.strictEqual(h.state.renders[h.state.renders.length - 1].text, 'Q\n\nC', '内容回到提交后');
  assert.strictEqual(h.ctrl.canRedo(), false);
  assert.strictEqual(h.ctrl.canUndo(), true);
  assert.ok(h.state.reports.join('|').indexOf('status.live-redo') >= 0);
  // ⚠️ 重做只是内存里的提交栈，⛔ 不写盘（`design/0047` §2.5）。
  assert.strictEqual(h.state.saves.length, 0, '磁盘一个字节都没动');
});

test('⭐ `⇧⌘Z` 没有可重做的 ⇒ `false` 并说一声（⛔ 无声 no-op）', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Q');
  await h.ctrl.leave({});
  assert.strictEqual(await h.ctrl.redo(), false);
  assert.ok(h.state.reports.join('|').indexOf('status.live-nothing-to-redo') >= 0);
});

test('⭐ 撤销之后**新提交** ⇒ 重做栈作废（`⇧⌘Z` 回到没有）', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Q');
  await h.ctrl.leave({});
  assert.strictEqual(await h.ctrl.undo(), true);
  assert.strictEqual(h.ctrl.canRedo(), true);
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Z');
  await h.ctrl.leave({});
  assert.strictEqual(h.ctrl.canRedo(), false, '内容分叉 ⇒ 旧的重做目标不成立');
});

// ── ⭐ 撤销/重做的**失败原子性**（`bugs/0020` 评审 P0，2026-11-02）──────────
//   ⚠️⚠️ 旧写法先同步改真值与两侧栈、再 await submit()，失败时什么都不还原：
//   屏幕停在旧文本、模型已经换了 ⇒ 下一次 ⌘S 会把**屏幕上没显示过**的内容写盘。

test('⭐⭐ 撤销渲染失败 ⇒ 全文/两侧栈原样还原，保存⛔ 不写出没显示过的内容', async function () {
  const opt = {};
  const h = harness(opt);
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Q');
  await h.ctrl.leave({});
  const committed = h.ctrl.fullText();
  assert.strictEqual(committed, 'Q\n\nC');

  opt.renderFails = true;
  assert.strictEqual(await h.ctrl.undo(), false, '渲染失败 ⇒ 撤销不能报成功');
  opt.renderFails = false;

  assert.strictEqual(h.ctrl.fullText(), committed, '⚠️ 模型必须原样（⛔ 不许留在"已撤销"那份）');
  assert.strictEqual(h.ctrl.canUndo(), true, '条目必须回到提交栈');
  assert.strictEqual(h.ctrl.canRedo(), false, '⛔ 不许留在重做栈里（那会把失败现场当成可重做）');
  assert.strictEqual(h.ctrl.isDirty(), true, '提交还没保存 ⇒ 脏状态不能被撤销失败清掉');

  // 失败之后保存，写出的必须是**屏幕上那份**（= 模型那份）。
  await h.ctrl.save();
  const last = h.state.saves[h.state.saves.length - 1];
  assert.strictEqual(last.text, committed, '⛔ 写盘内容必须与屏幕一致');
});

test('⭐⭐ 重做渲染失败 ⇒ 同样原样还原（屏幕 A、模型不许变成 B）', async function () {
  const opt = {};
  const h = harness(opt);
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Q');
  await h.ctrl.leave({});
  assert.strictEqual(await h.ctrl.undo(), true);
  const undone = h.ctrl.fullText();
  assert.strictEqual(undone, 'A\n\nC');

  opt.renderFails = true;
  assert.strictEqual(await h.ctrl.redo(), false);
  opt.renderFails = false;

  assert.strictEqual(h.ctrl.fullText(), undone, '⚠️ 仍是撤销之后那份');
  assert.strictEqual(h.ctrl.canRedo(), true, '条目必须回到重做栈');
  assert.strictEqual(h.ctrl.canUndo(), false, '⛔ 不许留在提交栈里');
});

test('⭐ 只打开文档、还没进过编辑时 `⌘Z` ⇒ 说一声（⛔ 静默 no-op）', async function () {
  const h = harness();
  // ⚠️ 会话是在 `begin()` 里建的 ⇒ 这里 `session === null`、`state === 'viewing'`。
  assert.strictEqual(h.ctrl.state(), 'viewing');
  assert.strictEqual(await h.ctrl.undo(), false);
  assert.ok(
    h.state.reports.join('|').indexOf('status.live-nothing-to-undo') >= 0,
    '没有会话 ≠ 这个语境不归我：必须说一句'
  );
});



test('⭐ `reseat()`：提交换掉整棵 `#doc` 之后，同一个视图重新挂到新节点上', async function () {
  // ⚠️ 这条守的是"提交完屏幕上那一块**看不见了**"——`mountDocument` 是
  //    `innerHTML` 整棵替换，旧节点连同 host 一起脱树，而视图、撤销栈、选区层都还活着。
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(h.state.swaps.length, 1);

  const newEl = { id: 'new-node' };
  assert.strictEqual(h.ctrl.reseat(newEl), true);
  assert.strictEqual(h.state.swaps.length, 2, '要再挂一次');
  assert.strictEqual(h.state.swaps[1].el, newEl, '挂到的是**新树里**那个节点');
  assert.strictEqual(h.state.swaps[1].host, h.state.swaps[0].host, 'host 还是同一个（⛔ 不重建视图）');
  assert.strictEqual(h.state.unswaps, 0, '⛔ 不许去 undo 一个已经脱树的旧节点');
});

test('`reseat()`：没有活动块 / 没给节点 ⇒ `false`，⛔ 不动任何东西', async function () {
  const h = harness();
  assert.strictEqual(h.ctrl.reseat({ id: 'x' }), false, '没在编辑态');
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(h.ctrl.reseat(null), false, '没给节点');
  assert.strictEqual(h.state.swaps.length, 1, '⛔ 不该多挂一次');
});

test('`reset()`：拆活动视图、清会话与栈', async function () {
  const h = harness();
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.type(0, 'Q');
  await h.ctrl.commit();
  await h.ctrl.reset();
  assert.strictEqual(h.ctrl.state(), 'viewing');
  assert.strictEqual(h.ctrl.lines(), null);
  assert.strictEqual(h.ctrl.canUndo(), false);
  // 同「退出（已改）」：发布段一次 ＋ 退出时还 `reseat()` 那份新宿主一次。
  assert.strictEqual(h.state.unswaps, 2, '活动视图也要拆掉');
});

// ⚠️ 这是 **`design/0059` 阶段 E 的欠账**，⛔ 不是产品终态：超大块点不进去
//    （`editable=false`）本身就是"用户点了没反应"的一种形态。`INV-LIVE-04` ① 要求
//    **进得去且逐像素不动**；本条只钉住"预算还在时不要更糟"（⛔ 别把拒绝当成合规结论）。
test('⚠️ 欠账：块太大 ⇒ 当前实现不进编辑态（`limits` 可注入；阈值是**未标定的初值**）', async function () {
  const h = harness({ text: 'A\nB\nC', limits: { maxBlockLines: 2 } });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  assert.strictEqual(r.ok, false);
  assert.ok(h.state.reports[0].indexOf('status.live-block-too-large') >= 0, h.state.reports[0]);
});

test('`identOfPayload` / `replyOfPayload`：后端把 `generation` 落在 `gen` 上', function () {
  const p = { real_path: '/a.md', gen: 7, doc_seq: 3, line_count: 9 };
  const id = C.identOfPayload(p);
  assert.strictEqual(id.generation, 7);
  assert.deepStrictEqual(C.replyOfPayload(p), {
    real_path: '/a.md',
    generation: 7,
    doc_seq: 3,
    line_count: 9,
    commit_seq: undefined,
  });
});

test('`rangeOf`：块的行区间原样进 splice（**唯一换算点**，差一行会改错块）', function () {
  assert.deepStrictEqual(C.rangeOf({ from: 0, to: 1 }), { from: 0, to: 1 });
  assert.deepStrictEqual(C.rangeOf({ from: 4, to: 7 }), { from: 4, to: 7 });
});

// ══════════════════════════════════════════════════════════════════════
//  `⌘↵` 新起一段（`design/0052` U7 / `bugs/0024`，⭐ 2026-10-28 按用户更正重写）
//
//  用户原话（逐字）：「`⌘Enter` 表示跳出当前引用块，在块后创建新的正文段落，并将真实编辑光标
//  放到该段落，保持编辑状态与输入焦点；不是退出到阅读态后等待按键重新进入。`Enter` 继续引用。」
//  ⇒ 下面这三条钉的正是**探针够不到的那一半**：会话正文（假后端不渲染 Markdown，`#doc` 里
//    一提交就是原件）、连续两次 `⌘↵` 的**位置单调性**、以及「一次 `⌘Z` 恢复内容**与光标**、
//    ⛔ 不吃掉后面那一块的正文」。
// ⚠️ 中文**组合期**不落事务那一半在 `live-input.test.js`（这里只判"落进哪一块"）。
// ══════════════════════════════════════════════════════════════════════

/** 每个非空行算一个 `Paragraph` 块（这几条判据的夹具都是单行段落）。 */
function 段落块(text) {
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    out.push([0, i + 1, i + 1, 1]);
  }
  return out;
}

/** 夹具 `A` / 空行 / `B`（⭐ **后面还有正文** —— 用户点名要覆盖的那种插入位置）。 */
async function 进第一块() {
  const h = harness({ text: 'A\n\nB', blocksFor: 段落块 });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  h.setCaret(1); // `A` 之后。⚠️ 非 0 才判得出"撤销恢复了光标"
  return h;
}

test('⭐ `⌘↵`：在**这一块之后**插空行（块后已有空行 ⇒ 2 行），光标落进新段落，⛔ 不退出编辑态', async function () {
  const h = await 进第一块();
  const ok = await h.ctrl.newParagraph();
  assert.strictEqual(ok, true);
  assert.strictEqual(h.ctrl.state(), 'editing', '⌘↵ 之后必须**仍**在编辑态（用户原话）');
  // ⭐ 块后**本来就有一行空行** ⇒ 只插 2 行（上分隔 ＋ 新段落），原来那行当新段落的下分隔
  //    （`bugs/0079`：无条件插三行会让新段落下方留 2 个空行，每按一次多一个）。
  //    ⚠️ 所以文本里是**三行空行**：中间那行是**新段落本体**（还没敲字，空串），
  //    ⛔ 不是第二个下分隔 —— 判据看的是「下分隔只有一行」，不是「空行只有两行」。
  assert.strictEqual(h.text(), 'A\n\n\n\nB', '只插了 2 行：上分隔 ＋ 新段落（原有空行当下分隔）');
  assert.deepStrictEqual(
    h.state.carets[h.state.carets.length - 1],
    0,
    '光标落在新段落**段首**（能立刻接着打字）'
  );
  assert.strictEqual(h.state.pendingHosts.length, 1, '用了一个临时宿主（空行在 comrak 里不是块）');
  assert.strictEqual(h.state.pendingHosts[0].after, 0, '宿主插在刚离开那一块**之后**');
});

test('⭐ 中文落进新段落，后面已有的正文逐字不变（用户点名的 ①与②）', async function () {
  const h = await 进第一块();
  await h.ctrl.newParagraph();
  h.type(0, '你好'); // 中文上屏
  const v = h.state.views[h.state.views.length - 1];
  assert.strictEqual(v.offsets, 2, '新段落是 0-based 第 2 行（插入行的**后一行**）');
  assert.strictEqual(h.ctrl.state(), 'editing');
  // 再按一次：把「你好」提交成真块，并**在它之后**再新起一段（连续两次 `⌘↵` 不许插到上面去）
  const ok = await h.ctrl.newParagraph();
  assert.strictEqual(ok, true);
  // ⚠️ 空行的**条数**现在每次固定（`bugs/0079` 修完不再累积）⇒ 判据仍比**非空行**的次序，
  //    ⛔ 不比空行个数（那属于 `bugs/0079` 自己的判据）。
  assert.deepStrictEqual(
    h.text().split('\n').filter(function (l) { return l.trim() !== ''; }),
    ['A', '你好', 'B'],
    '「你好」在 A 之后、B 之前；B 逐字不变'
  );
  assert.ok(/^A\n\n你好\n/.test(h.text()), '新段落紧跟在这一块之后（上分隔那一行还在）');
  assert.ok(/\n\nB$/.test(h.text()), 'B 前仍有空行分隔（⛔ 不许跟新段落并进同一段）');
});

test('⭐⭐ `bugs/0079` §6 ①②：`⌘↵` ＋ 输入 ＋ 退出 ⇒ 新段落下方**只有 1 个空行**，连按不累积', async function () {
  // ⚠️ 这一条量的是**提交出去的正文**（`h.text()` 取最后一次 `render_preview` 的入参），
  //    ⛔ 不是缓冲区：§6 ①② 说的「保存后的文件」就是这一份。
  const h = await 进第一块();
  await h.ctrl.newParagraph();
  h.type(0, '甲'); // ⚠️ 下标是**这一份视图内**的行（新段落视图只有一行）
  const out = await h.ctrl.leave({});
  assert.strictEqual(out.ok, true);
  assert.strictEqual(
    h.text(),
    'A\n\n甲\n\nB',
    '新段落下方**只有 1 个**空行（修复前是 2 个，每按一次多一个）'
  );
  // ② 连按第二次（重新点进「甲」那一块再 `⌘↵`）⇒ ⛔ 不累积，仍是每侧 1 个空行
  await h.ctrl.begin({ index: 1, block: h.block(1), el: h.el });
  await h.ctrl.newParagraph();
  h.type(0, '乙');
  assert.strictEqual((await h.ctrl.leave({})).ok, true);
  assert.strictEqual(h.text(), 'A\n\n甲\n\n乙\n\nB', '第二次之后仍然只有 1 个空行（修复前 3 个）');
});

test('⭐ `bugs/0079` §6 ③：文档末尾（块后**没有**分隔行）走 3 行那一支，末尾不多出空行', async function () {
  // ⚠️ 标题块后 / 列表块后与段落块后走的是**同一行** `insertAt = b.to`
  //    ⇒ 真正分成两支的只有「`b.to` 后面本来有没有空行」，文档末尾是 3 行那一支的常态形态。
  const h = harness({ text: 'A', blocksFor: 段落块 });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: h.el });
  await h.ctrl.newParagraph();
  assert.strictEqual(h.text(), 'A\n\n\n', '文档末尾：上分隔 ＋ 新段落 ＋ 下分隔');
  h.type(0, '甲');
  assert.strictEqual((await h.ctrl.leave({})).ok, true);
  // 文件以**一个**换行收尾（⛔ 不是 `A\n\n甲\n\n` 那种多出来的空行）
  assert.strictEqual(h.text(), 'A\n\n甲\n');
  // 另两种起点（标题块后 / 列表块后）走的是**同一行** `insertAt = b.to`，
  // 差别只在块种类 ⇒ 各跑一遍，防止将来有人给某个种类单独加分支。
  const 起点 = [
    ['标题块后', '# 行内\n\nB', [[1, 1, 1, 1]], '# 行内\n\n甲\n\nB'],
    ['列表块后', '- 一项\n- 二项\n\nB', [[3, 1, 2, 1]], '- 一项\n- 二项\n\n甲\n\nB'],
  ];
  for (let i = 0; i < 起点.length; i++) {
    const 名 = 起点[i][0];
    const hh = harness({ text: 起点[i][1], blocksFor: function () { return 起点[i][2]; } });
    await hh.ctrl.begin({ index: 0, block: hh.block(0), el: hh.el });
    await hh.ctrl.newParagraph();
    hh.type(0, '甲');
    assert.strictEqual((await hh.ctrl.leave({})).ok, true);
    assert.strictEqual(hh.text(), 起点[i][3], '§6 ③ ' + 名);
  }
});

test('⭐⭐ 一次 `⌘Z` 恢复「操作前的内容**与光标**」，⛔ 不吃掉后面那一块（用户点名的③）', async function () {
  const h = await 进第一块();
  h.type(0, 'AX'); // ⌘↵ **之前**敲的字
  h.setCaret(1); // 光标停在 X 之前
  assert.strictEqual(await h.ctrl.newParagraph(), true);
  assert.strictEqual(h.text(), 'AX\n\n\n\nB');
  // ⭐ 一次 ⌘Z（键级历史已空 ⇒ `main.js::undoOnce` 把这一整步交给 `undoNewParagraph`）
  assert.strictEqual(await h.ctrl.undoNewParagraph(), true);
  assert.strictEqual(
    h.text(),
    'AX\n\nB',
    '⛔ 只撤那几行空行：⌘↵ 之前敲的字必须还在，后面那一块的 B 也必须还在'
  );
  assert.strictEqual(h.ctrl.state(), 'editing', '撤销之后仍在编辑态，⛔ 不是退回阅读态');
  assert.strictEqual(h.ctrl.activeIndex(), 0, '回到操作前那一块');
  assert.strictEqual(
    h.state.carets[h.state.carets.length - 1],
    1,
    '光标回到操作前那一处（⛔ 不是段首、也不是段末）'
  );
});

// ══════════════════════════════════════════════════════════════════════
//  块内撤销的**归属**（`design/0052` U2）
//
//  ⚠️ 这里原来有 5 条"快照栈"判据（`push` / `undo` / `redo` / 上限 / `reset`）。
//     2026-10-27 起那份实现被删除、撤销改由 CM6 的 `history()` 承担 ⇒ 判据连同被测
//     对象一起消失。**改判"谁在记账"**，因为这是一次**静默**的回归：
//     谁把快照栈写回来，屏幕与手感都不会变，只有"撤销一次退一个字还是退一段"
//     这种用户才会发现 —— 而那正是 `bugs/0020` 那一类"写了但没人调"的同族。
// ══════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

function 读源(rel) {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
}

/** 注释剥成空白（保留行结构），⛔ 不让"注释里写着正确做法"混过源码级判据。 */
function 去注释(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

test('⭐ 控制器不再自己记账：快照栈已删除，撤销归 CM6 的 `history()`', function () {
  assert.strictEqual(
    C.createTextUndo,
    undefined,
    '控制器仍导出 `createTextUndo` ⇒ 仓里有两套撤销事实（`INV-KERNEL-01`）'
  );

  const 控制器 = 去注释(读源('src/live/index.js'));
  assert.strictEqual(
    /createTextUndo/.test(控制器),
    false,
    '`src/live/index.js` 里还留着快照栈的实现'
  );
});

test('⭐ 撤销的接线在 `main.js`：装 `history()`，`⌘Z` 调 `CM6.undo(view)` / `CM6.redo(view)`', function () {
  const main = 去注释(读源('src/main.js'));
  assert.ok(
    /extensions\.push\(\s*CM6\.history\(\)\s*\)/.test(main),
    '没装 `CM6.history()` ⇒ `CM6.undo` 恒返回 false，`⌘Z` 静默无效（`bugs/0020` 的形态）'
  );
  // ⚠️ `⌘Z` 的**第一件事**必须是键级撤销（`design/0052` U2）；
  //    ⭐ 键级空了之后才允许交给「`⌘↵` 新起一段」那一整步（`bugs/0024`）——
  //    `resolveUndo` 的纪律不变：⛔ 一次 ⌘Z 绝不跨层。
  const undoFn = /function undoOnce\(\)\s*\{([\s\S]*?)\n    \}/.exec(main);
  assert.ok(undoFn, '`main.js` 找不到 `undoOnce`');
  assert.ok(
    /CM6\.undo\(view\)/.test(undoFn[1]),
    '`undoOnce` 没走 `CM6.undo(view)`'
  );
  const 新段 = undoFn[1].indexOf('undoNewParagraph');
  assert.ok(
    新段 === -1 || undoFn[1].indexOf('CM6.undo(view)') < 新段,
    '「新起一段」的撤销排在了 `CM6.undo(view)` 之前 ⇒ 一次 ⌘Z 会跨层（`resolveUndo` 的纪律）'
  );
  assert.ok(
    /function redoOnce\(\)\s*\{\s*return CM6\.redo\(view\);/.test(main),
    '`redoOnce` 没走 `CM6.redo(view)`'
  );
  // ⚠️ 反向：⛔ 不许一边说归 CM6、一边又留一份自己的快照栈（那正是 U2 要消灭的东西）。
  assert.strictEqual(
    /createTextUndo/.test(main),
    false,
    '`src/main.js` 又在建快照栈了'
  );
  assert.strictEqual(
    /undo\.push\(/.test(main),
    false,
    '`onTransaction` 又在每次改动前压快照了'
  );
});
