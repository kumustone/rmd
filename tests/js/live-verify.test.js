// ⭐ `design/0054` **阶段 0** 的判据：**候选 → 校验 → 发布**。
//
// ⚠️ 这一份守的是"顺序"，不是"结构语义"——结构判决在 Rust
//    （`document/blocks.rs::verify_cell_edit` 那 9 条单测），这里只用假后端**照契约回包**，
//    验前端有没有把四件事做对：
//    ① 候选**对照的是本次编辑所基于的最新已提交全文**（⛔ 不是打开时原文）；
//    ② 校验没过 ⇒ **一个字节都不发布**（全文 / 撤销栈 / 磁盘 / 视图全不动）；
//    ③ 复核失败（迟到回包 / token 不符 / 缺验证结果）⇒ ⛔ 不许把失败读成"没改动"；
//    ④ 发布段里挂载炸了 ⇒ 真值回滚 ＋ `save()` 必须拒绝，⛔ 不许报"已保存"。
//
// ⚠️ 这些错**屏幕都不报错**：被拒的输入如果连视图一起消失，用户看到的是"我打的字没了"；
//    而失败被当成"没改动"时，`⌘S` 会安静地什么都不做，用户以为已经存上了。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../src/live/index.js');

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

/** 两行两列的表格（`|h1|h2|` / `|---|` / `|a|b|`），块序号 0，面积 3 行。 */
const TABLE = '|h1|h2|\n|---|---|\n|a|b|';
const TABLE_BLOCKS = [[5, 1, 3, 0]]; // Table，editable = 0（格子是另一条入口）
/**
 * 扁平格子表：行 1 两格（`h1` = 1..3、`h2` = 4..6），行 3 两格（`a` = 1..2、`b` = 3..4）。
 * ⚠️ `from`/`to` 是**行内 UTF-16 右开区间**（`design/0049` 的 `CellSpan`），⛔ 前端不换算。
 */
const TABLE_CELLS = [[0, [[1, 1, 3, 1], [1, 4, 6, 1], [3, 1, 2, 1], [3, 3, 4, 1]]]];

/**
 * @param {object} [o]
 * @param {string} [o.text] 夹具原文（默认那张两行两列的表格）
 * @param {function} [o.blocksFor] `(txt) -> number[][]`：块表（默认整张表一块）
 * @param {Array} [o.tableCells] `table_cells` 载荷（默认见 `TABLE_CELLS`）
 * @param {function} [o.verifyFn] `(arg) -> {ok, reason, detail}`：假后端的结构判决。
 * @param {function} [o.renderGate] `(第几次调用) -> Promise|null`：手工控制回包先后。
 * @param {function} [o.replyToken] `(token) -> string`：改回包里的 token（造"对不上"）。
 * @param {boolean} [o.dropVerify] 回包里**不带** `verify` 字段（造旧后端）。
 * @param {function} [o.mountFails] `(payload, n) -> boolean`：让某一次挂载抛错。
 * @param {function} [o.saveGate] `(第几次写盘) -> Promise|null`：手工控制"写盘在途"那段
 *   （2026-10-29 复评 P1-2：写盘期间还能提交/打字，正是丢稿的窗口）。
 */
function harness(o) {
  const opt = o || {};
  const text0 = opt.text === undefined ? TABLE : opt.text;
  const state = {
    text: text0,
    reports: [],
    renders: [],
    mounts: [],
    unswaps: 0,
    saves: [],
    ends: [],
    views: [],
    payload: null,
  };

  function payloadFor(txt) {
    const n = String(txt).split('\n').length;
    return {
      real_path: '/tmp/t.md',
      gen: 7,
      doc_seq: 3,
      line_count: n,
      html: txt,
      toc: [],
      block_kinds: KINDS,
      blocks: opt.blocksFor ? opt.blocksFor(txt) : TABLE_BLOCKS,
      table_cells: opt.tableCells === undefined ? TABLE_CELLS : opt.tableCells,
    };
  }
  state.payload = payloadFor(text0);
  state.payloadFor = payloadFor;

  const ctrl = C.createController({
    t: t,
    report: function (m) {
      state.reports.push(String(m));
    },
    beginEdit: async function () {
      return {
        real_path: '/tmp/t.md',
        text: state.text,
        envelope: { bom: false, eol: 'lf', lossy: false },
      };
    },
    endEdit: async function (arg) {
      state.ends.push(arg);
    },
    renderPreview: async function (arg) {
      state.renders.push(arg);
      if (opt.renderGate) {
        const g = opt.renderGate(state.renders.length);
        if (g) await g;
      }
      const p = state.payloadFor(arg.text);
      if (arg.verify) {
        // ⚠️ 真后端**总是**把 token 原样回显（`commands/edit.rs::VerifyReply`）。
        //    这里照契约办；"缺字段 / token 不符"用专门的夹具造。
        const v = opt.verifyFn ? opt.verifyFn(arg) : { ok: true };
        p.verify = {
          token: opt.replyToken ? opt.replyToken(arg.verify.token) : arg.verify.token,
          ok: v.ok === true,
          reason: v.reason || '',
          detail: v.detail || '',
          ms: 0,
        };
        if (opt.dropVerify) delete p.verify;
      }
      return p;
    },
    mount: function (p) {
      state.mounts.push(p);
      state.payload = p;
      if (opt.mountFails && opt.mountFails(p, state.mounts.length)) {
        // ⚠️ **不再**调 `notePayload`：真实现里那是挂载之后才做的事，挂载一炸它不跑。
        throw new Error('mount boom');
      }
      ctrl.notePayload(p);
    },
    nodeOf: function (index) {
      return { index: index, gen: state.mounts.length };
    },
    saveDisk: async function (arg) {
      state.saves.push(arg);
      // ⭐ 2026-10-29 复评 P1-2：手工控制"写盘在途"这段时间（期间还能提交/打字）。
      if (opt.saveGate) {
        const g = opt.saveGate(state.saves.length);
        if (g) await g;
      }
    },
    makeView: function (arg) {
      const v = {
        dom: { id: 'view' },
        lines: String(arg.text).split('\n'),
        offsets: arg.lineOffset,
        caretPos: 0,
        height: function () {
          return 100;
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
        focusAt: function () {
          v.focused = true;
        },
      };
      state.views.push(v);
      return {
        dom: v.dom,
        lines: v.linesNow,
        height: v.height,
        destroy: v.destroy,
        caret: v.caret,
        focusAt: v.focusAt,
      };
    },
    swap: function (arg) {
      void arg;
      return {
        undo: function () {
          state.unswaps++;
        },
      };
    },
    cellNodeOf: function (blockIndex, flat) {
      return { index: blockIndex, flat: flat, gen: state.mounts.length };
    },
    heightOf: function () {
      return 100;
    },
  });

  ctrl.notePayload(state.payload);

  return {
    ctrl: ctrl,
    state: state,
    /** 改活动视图的内容（模拟用户在格子里打字）。 */
    type: function (text) {
      state.views[state.views.length - 1].lines[0] = text;
    },
    /** 会话此刻的正文（最后一次提交进去的那一份；没提交过就是夹具原文）。 */
    text: function () {
      return state.renders.length ? state.renders[state.renders.length - 1].text : text0;
    },
    block: function (index) {
      return ctrl.blocks().filter(function (b) {
        return b.index === index;
      })[0];
    },
    /** 进第 `flat` 格。 */
    enterCell: function (flat) {
      return ctrl.begin({ index: 0, block: harnessBlock(), el: {}, cell: { flat: flat } });
    },
  };

  function harnessBlock() {
    return { index: 0, kind: 'Table', startLine: 1, endLine: 3, from: 0, to: 3, editable: false };
  }
}

// ── ① 基线 = 本次编辑所基于的最新已提交全文 ──────────────────────────────

test('⭐ 连续改两格（中间不保存）：第二次的基线必须是**第一次提交后**的全文', async function () {
  // ⚠️ 用户 2026-10-28 的逐字更正：「候选校验必须对照本次编辑所基于的**最新已提交全文**，
  //    不能对照打开时原文。否则连续修改两个格子、不保存，第二次就可能被误拒。」
  const h = harness();
  const r1 = await h.enterCell(2);
  assert.strictEqual(r1.ok, true, h.state.reports.join('|'));
  h.type('X');
  const c1 = await h.ctrl.commit();
  assert.deepStrictEqual(c1, { committed: true, failed: false, why: '' });

  const r2 = await h.enterCell(3);
  assert.strictEqual(r2.ok, true, h.state.reports.join('|'));
  h.type('Y');
  const c2 = await h.ctrl.commit();
  assert.deepStrictEqual(c2, { committed: true, failed: false, why: '' });

  // 第二次的候选与基线都必须建立在**第一次之后**那一份上。
  assert.strictEqual(h.state.renders[1].text, '|h1|h2|\n|---|---|\n|X|Y|');
  assert.strictEqual(
    h.state.renders[1].verify.baseline,
    h.state.renders[0].text,
    '第二次的基线 == 第一次提交后的全文（⛔ 不是打开时原文）'
  );
  assert.strictEqual(h.state.renders[0].verify.baseline, TABLE, '第一次的基线才是打开时那份');
  // 结构证据全由后端给：块号 / 行号 / 第几格 / 预期替换源码。
  assert.deepStrictEqual(h.state.renders[1].verify.block, 0);
  assert.deepStrictEqual(h.state.renders[1].verify.line, 3);
  assert.deepStrictEqual(h.state.renders[1].verify.cell, 3);
  assert.deepStrictEqual(h.state.renders[1].verify.replacement, 'Y');
});

test('块形态提交**不带** `verify`（写回校验就是行区间，`design/0054` §2.1）', async function () {
  const h = harness({ text: 'A\n\nC', blocksFor: function () { return [[0, 1, 1, 1], [0, 3, 3, 1]]; }, tableCells: [] });
  const r = await h.ctrl.begin({ index: 0, block: h.block(0), el: {} });
  assert.strictEqual(r.ok, true, h.state.reports.join('|'));
  h.type('Z');
  const out = await h.ctrl.commit();
  assert.strictEqual(out.committed, true);
  assert.strictEqual(h.state.renders[0].verify, null, '块级对象的 `verify` 必须是显式的 null');
});

// ── ② 校验没过 ⇒ 一个字节都不发布 ────────────────────────────────────────

test('⭐ 结构被拒 ⇒ 全文 / 撤销栈 / 磁盘 / 视图**全部原状**（失败不污染）', async function () {
  const h = harness({ verifyFn: function () { return { ok: false, reason: 'neighbor_changed', detail: '右邻格变了' }; } });
  await h.enterCell(2);
  h.type('X');
  const out = await h.ctrl.commit();

  assert.deepStrictEqual(out, { committed: false, failed: true, why: 'neighbor_changed' });
  assert.deepStrictEqual(h.ctrl.lines(), TABLE.split('\n'), '会话正文一个字节都没动');
  assert.strictEqual(h.ctrl.stackSize(), 0, '⛔ 不许压撤销条目（否则 ⌘Z 撤的是没发生过的事）');
  assert.strictEqual(h.state.mounts.length, 0, '⛔ 不许上屏');
  assert.strictEqual(h.state.saves.length, 0, '⛔ 不许碰磁盘');
  // ⭐ 用户唯一那份输入必须还在：视图没销毁、光标没丢、内容还是他敲的。
  assert.notStrictEqual(h.state.views[0].destroyed, true, '⛔ 不许销毁唯一持有输入的那个视图');
  assert.deepStrictEqual(h.state.views[0].lines, ['X'], '输入必须原样留着');
  assert.strictEqual(h.ctrl.state(), 'editing', '仍在编辑态（用户可以直接接着改）');
  assert.ok(
    h.state.reports.join('|').indexOf('status.live-verify-failed') >= 0,
    h.state.reports.join('|')
  );
});

test('⭐ 校验失败之后 `save()` 必须拒绝 —— ⛔ 不许把"改了但被拒"写成"没改动"', async function () {
  const h = harness({ verifyFn: function () { return { ok: false, reason: 'cell_content' }; } });
  await h.enterCell(2);
  h.type('X');
  await h.ctrl.commit();

  const saved = await h.ctrl.save();
  assert.strictEqual(saved, false, '提交失败时 ⛔ 不许继续写盘');
  assert.strictEqual(h.state.saves.length, 0, '磁盘一个字节都不许动');
});

test('⭐ 被拒之后接着改同一个格：输入还在、基线仍是最新那份，第二次提交成功且只写一次', async function () {
  // ⚠️ 用户 2026-10-28 的实施范围第二条：「失败保留输入、不污染全文和历史」。
  //    只验"拒了之后什么都没变"还不够——**用户会接着改**。若失败把视图/区间弄脏，
  //    第二次要么写不进去，要么写进错位的列，而屏幕上只会看到"我的字没了 / 串到隔壁格"。
  let 第几次 = 0;
  const h = harness({
    verifyFn: function () {
      第几次++;
      // 第一次：后端判结构不对（比如那一行此刻不是它以为的表）；之后放行。
      return 第几次 === 1 ? { ok: false, reason: 'table_changed', detail: '表结构变了' } : { ok: true };
    },
  });
  await h.enterCell(2);
  h.type('X');
  const bad = await h.ctrl.commit();
  assert.deepStrictEqual(bad, { committed: false, failed: true, why: 'table_changed' });
  assert.strictEqual(h.ctrl.stackSize(), 0, '失败不许留撤销条目');
  assert.strictEqual(h.ctrl.state(), 'editing', '仍在编辑态（用户可以直接接着改）');

  // 用户接着改，再提交一次。
  h.type('XY');
  const ok = await h.ctrl.commit();
  assert.deepStrictEqual(ok, { committed: true, failed: false, why: '' });
  assert.strictEqual(h.state.renders.length, 2, '两次提交各一次预览（失败那次也发了）');
  assert.strictEqual(
    h.state.renders[1].verify.baseline,
    TABLE,
    '基线仍是**最新已提交**的那份（失败没有污染它）'
  );
  assert.strictEqual(h.state.renders[1].verify.replacement, 'XY');
  assert.strictEqual(h.ctrl.lines().join('\n'), '|h1|h2|\n|---|---|\n|XY|b|');
  assert.strictEqual(h.ctrl.stackSize(), 1, '只有成功那一次压栈');
  assert.strictEqual(h.state.mounts.length, 1);
  // 失败那次没有把"用户输入"或"视图"弄丢。
  assert.deepStrictEqual(h.state.views[0].lines, ['XY']);
});

test('⭐ 同一个格连改两次：第二次按**第一次之后**的区间写回（区间跟着内容走）', async function () {
  // ⚠️ `bugs/0024` 那一族：提交之后 `a.cell.to` 若停在旧值，第二次变长就会
  //    ① 把刚写进去的字当成"区间外"再拼一遍 ⇒ 字写重；② 截断邻居格。
  //    这里用纯逻辑把那条 off-by-one 钉死（GUI 侧同族是 `Q15`/`Q5d`）。
  const h = harness();
  await h.enterCell(2);
  // ⚠️ 第一次就要**变长**（`a` → `XX`）：同长度的话陈旧区间与正确区间恰好重合，
  //    这条判据对 `a.cell.to` 的 off-by-one 会**不敏感**（改坏了也照样绿）。
  h.type('XX');
  assert.deepStrictEqual(await h.ctrl.commit(), { committed: true, failed: false, why: '' });
  assert.strictEqual(h.ctrl.lines().join('\n'), '|h1|h2|\n|---|---|\n|XX|b|');

  h.type('XYZ');
  assert.deepStrictEqual(await h.ctrl.commit(), { committed: true, failed: false, why: '' });
  assert.strictEqual(h.ctrl.lines().join('\n'), '|h1|h2|\n|---|---|\n|XYZ|b|', '⛔ 不许写重、不许吃掉右邻格');
  assert.strictEqual(h.state.renders[1].verify.replacement, 'XYZ');
  assert.strictEqual(h.state.renders[1].verify.line, 3, '仍是同一行');
  assert.strictEqual(h.ctrl.stackSize(), 2, '两次真实改动 = 两条撤销条目');
  // ⚠️ `undo()` 只在阅读态可用（`state !== 'viewing'` 直接 false，这是产品口径）⇒ 先退出再撤。
  //    它本身也是异步的（撤销要重渲一次），不 await 会读到**还没换过去**的那份文本。
  assert.deepStrictEqual(await h.ctrl.leave({}), { ok: true, committed: false });
  assert.strictEqual(await h.ctrl.undo(), true, '撤销要能退回去');
  assert.strictEqual(h.ctrl.lines().join('\n'), '|h1|h2|\n|---|---|\n|XX|b|', '撤销退到第一次之后那一份');
});

test('⭐⭐ 单元格提交的迟到回包同样丢掉（结构校验不改变"最后一次赢"）', async function () {
  // ⚠️ 单元格与块级共用 `publish()` 的那条复核，但候选是另一条路造的
  //    （`commitCell` 先 encode ＋ padFor ＋ splice）。这条判据防的是
  //    "在格子这条新路上又加了一次 await、把 `renderSeq` 复核绕过去"。
  /** @type {any} */
  let release = function () {};
  const gate = new Promise(function (res) {
    release = res;
  });
  const h = harness({
    renderGate: function (n) {
      return n === 1 ? gate : null;
    },
  });
  await h.enterCell(2);
  h.type('X');
  const first = h.ctrl.commit(); // 卡在 gate 上
  while (h.state.renders.length === 0) await Promise.resolve();

  h.type('Y');
  const second = await h.ctrl.commit();
  assert.deepStrictEqual(second, { committed: true, failed: false, why: '' });
  release();
  const late = await first;

  assert.deepStrictEqual(late, { committed: false, failed: false, why: 'stale' }, '迟到那一包必须被丢');
  assert.strictEqual(h.state.mounts.length, 1, '只上屏一次（后到的那一份）');
  assert.strictEqual(h.ctrl.lines().join('\n'), '|h1|h2|\n|---|---|\n|Y|b|', '⛔ 迟到的 X 不许盖掉 Y');
  assert.strictEqual(h.ctrl.stackSize(), 1);
});

test('回包里**缺** `verify`（旧后端 / 形状不对）⇒ ⛔ 不许读成通过', async function () {
  const h = harness({ dropVerify: true });
  await h.enterCell(2);
  h.type('X');
  const out = await h.ctrl.commit();
  assert.deepStrictEqual(out, { committed: false, failed: true, why: 'verify-missing' });
  assert.strictEqual(h.state.mounts.length, 0);
  assert.deepStrictEqual(h.ctrl.lines(), TABLE.split('\n'));
  assert.ok(h.state.reports.join('|').indexOf('status.live-verify-missing') >= 0, h.state.reports.join('|'));
});

test('`token` 对不上（回包是另一趟的）⇒ ⛔ 不许发布', async function () {
  const h = harness({ replyToken: function () { return 'v999'; } });
  await h.enterCell(2);
  h.type('X');
  const out = await h.ctrl.commit();
  assert.deepStrictEqual(out, { committed: false, failed: true, why: 'verify-missing' });
  assert.strictEqual(h.state.mounts.length, 0);
});

// ── ③ 迟到回包 / 新输入穿插 ──────────────────────────────────────────────

test('⭐⭐ 迟到回包 ⇒ 那一包**丢**，⛔ 不许覆盖后来的内容', async function () {
  // ⚠️ 用户场景：改一块 → 不等渲染就接着改 → 两次回包先后到达。
  //    迟到的第一次如果照旧"复核通过就提交"，屏幕上就是"我刚敲的字自己退回去了"。
  /** @type {any} */
  let release = function () {};
  const gate = new Promise(function (res) {
    release = res;
  });
  const h = harness({
    text: 'A\n\nC',
    blocksFor: function (txt) {
      const n = txt.split('\n').length;
      return [[0, 1, 1, 1], [0, n, n, 1]];
    },
    tableCells: [],
    renderGate: function (n) {
      return n === 1 ? gate : null;
    },
  });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: {} });
  h.type('AAA');
  const first = h.ctrl.commit(); // 卡在 gate 上
  // 等第一次真的进了 `renderPreview`（否则下面那次 commit 可能抢在它前面发车）
  while (h.state.renders.length === 0) await Promise.resolve();

  h.type('BBB');
  const second = await h.ctrl.commit();
  assert.strictEqual(second.committed, true);
  release();
  const late = await first;

  assert.deepStrictEqual(late, { committed: false, failed: false, why: 'stale' }, '迟到那一包必须被丢');
  assert.strictEqual(h.state.mounts.length, 1, '只上屏一次（后到的那一份）');
  assert.strictEqual(h.ctrl.lines().join('\n'), 'BBB\n\nC');
  assert.strictEqual(h.state.saves.length, 0);
});

// ── ④ 发布段挂载异常 ⇒ 回滚 ＋ 后续不许报成功 ────────────────────────────

test('⭐⭐ 发布段挂载炸了：真值回滚，`save()` 拒绝（⛔ 不许出现"看不见的改动"）', async function () {
  const h = harness({
    text: 'A\n\nC',
    blocksFor: function (txt) {
      const n = txt.split('\n').length;
      return [[0, 1, 1, 1], [0, n, n, 1]];
    },
    tableCells: [],
    mountFails: function (p, n) {
      return n === 1 && p.html === 'Z\n\nC';
    },
  });
  await h.ctrl.begin({ index: 0, block: h.block(0), el: {} });
  h.type('Z');
  const out = await h.ctrl.commit();

  assert.strictEqual(out.committed, false);
  assert.strictEqual(out.failed, true, '挂载失败必须报成失败');
  assert.strictEqual(h.ctrl.lines().join('\n'), 'A\n\nC', '真值要回滚（撤销栈那条被弹回去）');
  assert.strictEqual(h.ctrl.stackSize(), 0, '⛔ 不许留下一条撤销条目');
  assert.ok(
    h.state.reports.join('|').indexOf('status.live-publish-failed') >= 0,
    h.state.reports.join('|')
  );

  // ⚠️ 从此**任何**保存都不许报成功：屏幕上没有这份改动，写下去就是把用户骗了。
  const saved = await h.ctrl.save();
  assert.strictEqual(saved, false);
  assert.strictEqual(h.state.saves.length, 0, '⛔ 磁盘一个字节都不许动');
});

// ── ⑤ 失败必须传出去：`leave()` / `begin()` 的调用方不许当"没事发生" ──────

test('⭐ 退出时校验被拒 ⇒ 视图**活着**、输入还在、授权没还（调用方能看见失败）', async function () {
  const h = harness({ verifyFn: function () { return { ok: false, reason: 'table_changed' }; } });
  await h.enterCell(2);
  h.type('X');
  const left = await h.ctrl.leave({});

  assert.deepStrictEqual(left, { ok: false, committed: false, failed: true, why: 'table_changed' });
  assert.strictEqual(h.state.views[0].destroyed, undefined, '⛔ 不许销毁视图');
  assert.deepStrictEqual(h.state.views[0].lines, ['X'], '用户那份输入还在');
  assert.strictEqual(h.ctrl.state(), 'editing', '仍在编辑态');
  assert.strictEqual(h.state.ends.length, 0, '⛔ 不许把写授权还回去（用户还在改）');
  assert.strictEqual(h.ctrl.activeIndex(), 0, '活动块⛔ 不许被置空');
});

test('⭐ 退出失败之后换块 ⇒ ⛔ 不换（否则两个视图同时持有"真值"）', async function () {
  const h = harness({ verifyFn: function () { return { ok: false, reason: 'table_changed' }; } });
  await h.enterCell(2);
  h.type('X');
  const r = await h.enterCell(3);
  assert.deepStrictEqual(r, { ok: false, why: 'commit-failed' });
  assert.strictEqual(h.state.views.length, 1, '⛔ 不许再建第二个视图');
  assert.strictEqual(h.ctrl.state(), 'editing');
});

// ── ⑥ 无改动 ⇒ 零字节变化（`bugs/0040`，评审第 14 条 (b)）────────────────

test('⭐⭐ 点进含 `<br />` 的格子、什么都不改再点出去 ⇒ 源码一个字节都不变', async function () {
  // ⚠️ 这条错**屏幕上完全看不见**：`decode` 把 `<br />` 归一成换行，`encode` 再写回 `<br>`
  //    ⇒ 用户只是点进去看了一眼，磁盘上的文件就被改成了另一种写法。
  const text = '|h1|h2|\n|---|---|\n|a<br />b|b|';
  const h = harness({
    text: text,
    tableCells: [[0, [[1, 1, 3, 1], [1, 4, 6, 1], [3, 1, 9, 1], [3, 10, 11, 1]]]],
  });
  const r = await h.enterCell(2);
  assert.strictEqual(r.ok, true, h.state.reports.join('|'));
  assert.deepStrictEqual(h.state.views[0].lines, ['a', 'b'], '视图里是换行，⛔ 不是字面的 `<br />`');

  assert.deepStrictEqual(await h.ctrl.commit(), { committed: false, failed: false, why: '' });
  assert.strictEqual(h.state.renders.length, 0, '没改动 ⇒ 一次重渲都不该有');
  assert.strictEqual(h.state.mounts.length, 0, '没改动 ⇒ 一次挂载都不该有');
  assert.strictEqual(h.ctrl.lines().join('\n'), text, '源码逐字不变');

  assert.deepStrictEqual(await h.ctrl.leave({}), { ok: true, committed: false }, '退出同样不算改动');
  assert.strictEqual(h.ctrl.lines().join('\n'), text, '退出之后仍然逐字不变');
  assert.strictEqual(h.state.ends.length, 1, '没改动 ⇒ 写授权按"放弃"还回去');
});

// ── ⑦ 字节闸门报的是**字节**，⛔ 不是行数（评审第 17 条）──────────────────

test('⭐ 超字节上限 ⇒ 报的是 KB，⛔ 不说「太大（1 行）」', async function () {
  // ⚠️ 旧的判据比的是 `text.length`（UTF-16 码元）且文案写「{lines} 行」——
  //    3 行 / 300 KB 的块会显示「太大（3 行）」，用户只会去数行数。
  const big = 'x'.repeat(300 * 1024);
  // ⚠️ 夹具里那唯一的块是**段落** ⇒ `table_cells` 必须是空的。
  //    （2026-10-29 评审第 13 条的交叉断言会把"段落块带格子表"判成载荷不一致 ⇒
  //      `begin` 在字节闸门之前就以 `issues` 拒了，这条判据会量错东西。）
  const h = harness({ text: big, blocksFor: function () { return [[0, 1, 1, 1]]; }, tableCells: [] });
  const r = await h.ctrl.begin({ index: 0, block: { index: 0, kind: 'Paragraph', startLine: 1, endLine: 1, from: 0, to: 1, editable: true }, el: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'too-large');
  const msg = h.state.reports.join('|');
  assert.ok(msg.indexOf('status.live-block-too-large-bytes') >= 0, msg);
  assert.ok(msg.indexOf('kb=300') >= 0, '报出来的 KB 要对得上：' + msg);
  assert.ok(msg.indexOf('status.live-block-too-large ') < 0, '⛔ 不许再走行数那条文案');
});

// ── ⑧ `verify` 对 `structure` 类对象是**必需**的（评审第 7 条）────────────
//
// ⚠️ 为什么是**源码级**判据：这条闸门守的是"**我们自己的接线**"——`live/objects.js`
//    声明 `verify: 'structure'` 的对象提交时必须带结构证据。从公开 API 走，
//    `commitCell` 永远记得填 ⇒ 外部行为**无法**构造出"漏填"这一态（那正是缺陷的特征：
//    只有新加一类对象时才发生）。⇒ 判据落在源码上，并靠变异证明它在承重。

test('⭐⭐ `publish()`：声明了 `structure` 的对象⛔ 不许不带校验就发布', function () {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src/live/index.js'), 'utf8');
  const at = code.indexOf('async function publish(');
  assert.ok(at >= 0, '⛔ 找不到 `publish(`');
  const head = code.slice(at, code.indexOf('// —— ① 造候选', at));
  assert.ok(head.indexOf('LIVE.objects.policyOf(') >= 0,
    '⛔ `publish()` 里没有按策略表判"这一类对象要不要结构证据"');
  assert.ok(head.indexOf("pol.verify === 'structure'") >= 0,
    '⛔ 判了策略却没用 `structure` 那一档');
  assert.ok(head.indexOf('status.live-verify-plan') >= 0,
    '⛔ 拒收时没有自己的文案（借用 `live-verify-missing` 会把"后端没回包"与"我们没问"混成一句）');
  assert.ok(head.indexOf('verify-plan') >= 0, '⛔ 拒收理由没有可判的 `why`');
  // ⚠️ 闸门必须排在**造候选之前**：排在后面就说明"已经动过嗓子再反悔"，
  //    而且 `state = 'committing'` 之后返回会把状态机留在 committing 上。
  const candAt = code.indexOf('const candLines', at);
  assert.ok(candAt > at, '⛔ 找不到造候选那一步');
  assert.ok(code.indexOf('LIVE.objects.policyOf(', at) < candAt,
    '⛔ 闸门排在造候选之后 —— 那时已经算过 range/next，回滚面更大');
});

// ── ⑨ 2026-10-29 复评：**已输入 / 已提交 / 已写盘**三个状态必须分开问 ──────
//
// ⚠️ 共同根因（复评原话）：「架构上，'已输入、已提交、已写盘'三个状态仍未贯通」。
//    这三组判据**只在组合操作与失败恢复**里才红：单看每一步都"成功"，
//    而用户的字在屏幕上看不见的地方消失了。

test('⭐⭐ P1-1：视图里**打了字但还没提交** ⇒ `isDirty()` 立刻为真', async function () {
  const h = harness();
  assert.strictEqual(h.ctrl.isDirty(), false, '基线：刚挂上来不脏');
  await h.enterCell(2);
  h.type('NOT_SAVED');
  // ⚠️ 负对照就在下一条：**进格但一个字不打**必须仍不脏（否则每次点进去都弹脏提示）。
  assert.strictEqual(h.ctrl.isDirty(), true, '⛔ 已输入没算进脏 ⇒ 切文档时不问、直接丢');
  assert.strictEqual(h.state.renders.length, 0, '负对照：一个字都还没提交');

  const h2 = harness();
  await h2.enterCell(2);
  assert.strictEqual(h2.ctrl.isDirty(), false, '进格不打字⛔ 不算脏');
});

test('⭐⭐ P1-2：写盘期间又提交了一笔 ⇒ 成功后**仍然算脏**（基线绑定写出去的那份快照）', async function () {
  /** @type {(v?:any)=>void} */
  let release = function () {};
  const gate = new Promise(function (r) {
    release = r;
  });
  const h = harness({
    saveGate: function () {
      return gate;
    },
  });
  await h.enterCell(2);
  h.type('X');
  const saving = h.ctrl.save(); // 提交 'X' 进内存 → 卡在写盘
  while (h.state.saves.length === 0) await Promise.resolve();
  // ⚠️ 写盘在途：用户在同一个格子里接着改、并且真的提交（`commit()` 不等 `save()`）。
  h.type('XY');
  const c = await h.ctrl.commit();
  assert.deepStrictEqual(c, { committed: true, failed: false, why: '' });
  release();
  assert.strictEqual(await saving, true, '这一次写盘本身是成功的');

  assert.strictEqual(h.state.saves.length, 1);
  assert.strictEqual(h.state.saves[0].text, '|h1|h2|\n|---|---|\n|X|b|', '写出去的是**发起时**那份快照');
  // ⭐⭐ 核心：磁盘上只有 'X'，'Y' 只活在内存里 ⇒ ⛔ 不许读成"已保存"。
  assert.strictEqual(h.ctrl.isDirty(), true, '⛔ 写盘期间的新提交被标成了"已保存"（丢稿提示从此失效）');

  // 再存一次 ⇒ 这次把 'XY' 写下去，脏标记才该落下来。
  assert.strictEqual(await h.ctrl.save(), true);
  assert.strictEqual(h.state.saves.length, 2);
  assert.strictEqual(h.state.saves[1].text, '|h1|h2|\n|---|---|\n|XY|b|');
  assert.strictEqual(h.ctrl.isDirty(), false);
});

test('⭐⭐ P1-2：两次 `save()` 并发进来 ⇒ 串行执行，⛔ 不各写各的', async function () {
  /** @type {(v?:any)=>void} */
  let release = function () {};
  const gate = new Promise(function (r) {
    release = r;
  });
  const h = harness({
    saveGate: function (n) {
      return n === 1 ? gate : null;
    },
  });
  await h.enterCell(2);
  h.type('X');
  const first = h.ctrl.save();
  while (h.state.saves.length === 0) await Promise.resolve();
  h.type('XY');
  const second = h.ctrl.save(); // ⛔ 不许在第一次还没回来时并行发车
  // ⚠️ 必须**真的把它推到该发车的位置**再判：它前面还有 `commit()` → `renderPreview`
  //    好几层微任务 ⇒ 只看一轮 `await Promise.resolve()` 时，没串行化也看不出来（恒绿）。
  for (let i = 0; i < 200 && h.state.saves.length < 2; i++) await Promise.resolve();
  assert.strictEqual(h.state.saves.length, 1, '第二条写盘必须排在第一条后面');
  assert.strictEqual(h.state.renders.length, 1, '⛔ 第一次写盘还没回来，第二次的提交已经发车');
  release();
  assert.strictEqual(await first, true);
  assert.strictEqual(await second, true);
  assert.deepStrictEqual(
    h.state.saves.map(function (s) {
      return s.text;
    }),
    ['|h1|h2|\n|---|---|\n|X|b|', '|h1|h2|\n|---|---|\n|XY|b|'],
    '写盘的顺序 = 用户操作的顺序'
  );
  assert.strictEqual(h.ctrl.isDirty(), false);
});

test('⭐⭐ P1-3：三轮提交期间一直在打字 ⇒ `leave()` 如实失败、视图与输入都还在', async function () {
  /** @type {Array<function():void>} */
  const rels = [];
  const h = harness({
    renderGate: function () {
      // ⚠️ 只拦**前三轮**（那一趟 `leave()` 的预算）：末尾那次"再按一次就收敛"的
      //    负对照必须能自己跑完，⛔ 别让它卡在一个没人放行的门上（测试会挂死而不是变红）。
      if (rels.length >= 3) return null;
      let rel;
      const p = new Promise(function (r) {
        rel = r;
      });
      rels.push(/** @type {any} */ (rel));
      return p;
    },
  });
  await h.enterCell(2);
  h.type('A');
  const leaving = h.ctrl.leave({});
  const typed = ['AB', 'ABC', 'ABCD'];
  for (let round = 0; round < typed.length; round++) {
    while (h.state.renders.length < round + 1) await Promise.resolve();
    h.type(typed[round]); // ⚠️ 渲染在途时接着打字（这正是用户会做的事）
    rels[round]();
  }
  const left = await leaving;
  assert.deepStrictEqual(left, { ok: false, committed: true, failed: true, why: 'rounds' },
    '⛔ 预算耗尽但还脏 ⇒ 必须报失败（旧写法报 `failed:false`，然后销毁唯一那份输入）');
  assert.strictEqual(h.ctrl.state(), 'editing', '仍在编辑态');
  assert.strictEqual(h.state.views[0].destroyed, undefined, '⛔ 不许销毁视图');
  assert.deepStrictEqual(h.state.views[0].lines, ['ABCD'], '用户最后那份输入还在');
  assert.ok(h.state.reports.join('|').indexOf('status.live-still-dirty') >= 0, h.state.reports.join('|'));
  assert.strictEqual(h.ctrl.activeIndex(), 0, '活动块⛔ 不许被置空');

  // ⭐ 负对照：不再打字 ⇒ 同一条 `leave()` 下一次就收敛（⛔ 不是"永久卡住"）。
  const again = await h.ctrl.leave({});
  assert.strictEqual(again.ok, true);
  assert.strictEqual(h.ctrl.state(), 'viewing');
  assert.strictEqual(h.state.views[0].destroyed, true, '收敛之后才许销毁视图');
});

test('⭐⭐ P2-4：单元格发布失败 ⇒ **区间也退回去**（重试不会拼出错位的候选）', async function () {
  const h = harness({
    mountFails: function (p, n) {
      return n === 1;
    },
  });
  await h.enterCell(2); // `|a|b|` 的 `a` 格：区间 [1,2)
  h.type('LONGER');
  const out = await h.ctrl.commit();
  assert.strictEqual(out.failed, true, '挂载失败必须报失败');
  assert.strictEqual(h.ctrl.lines().join('\n'), TABLE, '全文要回滚');

  // ⭐⭐ 核心：旧的 catch 只 `session.undo()`，`a.cell.to` 还停在 1+6=7 ⇒ 下一轮候选会把
  //    `LONGER` 的列区间套到原文那一行上（那里只有 8 个字符，切出来是 `a|b|` 的中段），
  //    真后端按结构拒、假后端照收 ⇒ "重试一次就坏"只在真机上出现。
  const again = await h.ctrl.commit();
  assert.deepStrictEqual(again, { committed: true, failed: false, why: '' }, '回滚干净 ⇒ 重试必须能成');
  assert.strictEqual(h.ctrl.lines().join('\n'), '|h1|h2|\n|---|---|\n|LONGER|b|');
  // ⚠️ 结构证据里那一格仍是**第 3 行第 0 格**（区间退回之后按新内容重算，⛔ 不是沿用旧的）。
  assert.strictEqual(h.state.renders[1].verify.line, 3);
  assert.strictEqual(h.state.renders[1].verify.cell, 2);
  assert.strictEqual(h.state.renders[1].verify.replacement, 'LONGER');
});

test('⭐⭐ P2-4：发布失败之后**重试成功** ⇒ 毒标记解除，`save()` 重新可用', async function () {
  const h = harness({
    mountFails: function (p, n) {
      return n === 1;
    },
  });
  await h.enterCell(2);
  h.type('X');
  const bad = await h.ctrl.commit();
  assert.strictEqual(bad.failed, true);
  assert.strictEqual(await h.ctrl.save(), false, '挂载失败之后 ⛔ 不许写盘');
  assert.strictEqual(h.state.saves.length, 0, '—— 磁盘一个字节不许动');

  // 再提交一次（这次挂载成功）⇒ 屏幕与会话重新对上 ⇒ 保存解禁。
  assert.deepStrictEqual(await h.ctrl.commit(), { committed: true, failed: false, why: '' });
  assert.strictEqual(await h.ctrl.save(), true);
  assert.strictEqual(h.state.saves.length, 1);
  assert.strictEqual(h.state.saves[0].text, '|h1|h2|\n|---|---|\n|X|b|');
});
