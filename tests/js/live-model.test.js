// `design/0047` §3.2 的 JS 纯逻辑判据之二：**唯一全文模型 ＋ 提交 ＋ 两层撤销的下层**。
//
// ⚠️ 这一份测的是 `src/live/model.js`（纯函数，⛔ 不碰 DOM / Tauri / 定时器）。
//    语义必须与 `tools/live-probe/js/{lineModel,undoStack}.js` 逐条一致——
//    那两份是步骤 0 的可运行证据（`design/0047` §7.1.1）。
//
// ⭐ 每条都要正反例的理由：这里错一次都不会报错，只会**静默改错一块文本**
//    （`INV-LIVE-13` 的"合文错位"就是这类）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const M = require('../../src/live/model.js');

// ── 行模型 ─────────────────────────────────────────────────────────────────

test('行模型：末尾换行产生一个**真实的空行**（`LineIndex` 同口径）', function () {
  assert.deepStrictEqual(M.splitLines('a\n'), ['a', '']);
  assert.deepStrictEqual(M.splitLines('a\nb'), ['a', 'b']);
  assert.deepStrictEqual(M.splitLines(''), ['']);
  assert.strictEqual(M.lineCountOf(M.splitLines('a\n')), 2);
  // ⚠️ 反例：`filter(Boolean)` 那种写法会让行数少一，块表右端立刻越界。
  assert.notStrictEqual(M.splitLines('a\n').length, 1);
});

test('行模型：split ⇄ join 逐字节可逆', function () {
  const samples = ['', '\n', 'a', 'a\n', 'a\n\n', '# 标题\n\n正文\n', 'a\r\nb\n'];
  for (const s of samples) {
    assert.strictEqual(M.joinLines(M.splitLines(s)), s, JSON.stringify(s));
  }
});

test('行模型：⛔ 不规范化行尾（`\\r` 进来就是 bug，不在这里修）', function () {
  assert.deepStrictEqual(M.splitLines('a\r\nb'), ['a\r', 'b']);
});

// ── applyEdit ──────────────────────────────────────────────────────────────

test('splice：按 0-based 半开区间替换，⛔ 不改入参', function () {
  const lines = ['a', 'b', 'c', 'd'];
  const out = M.applyEdit(lines, { from: 1, to: 3 }, ['B', 'C', 'X']);
  assert.deepStrictEqual(out, ['a', 'B', 'C', 'X', 'd']);
  assert.deepStrictEqual(lines, ['a', 'b', 'c', 'd'], '入参数组必须原样');
  // 插入（空区间）与删除（空内容）
  assert.deepStrictEqual(M.applyEdit(lines, { from: 2, to: 2 }, ['新']), ['a', 'b', '新', 'c', 'd']);
  assert.deepStrictEqual(M.applyEdit(lines, { from: 2, to: 4 }, []), ['a', 'b']);
});

test('splice：越界**抛错**，⛔ 不夹取', function () {
  const lines = ['a', 'b'];
  assert.throws(function () {
    M.applyEdit(lines, { from: 0, to: 9 }, []);
  }, /区间越界/);
  assert.throws(function () {
    M.applyEdit(lines, { from: 1, to: 0 }, []);
  }, /区间越界/);
  assert.throws(function () {
    M.applyEdit(lines, { from: -1, to: 1 }, []);
  }, /区间越界/);
  assert.throws(function () {
    M.applyEdit(lines, { from: 0.5, to: 1 }, []);
  }, /区间越界/);
});

// ── 身份闸 ─────────────────────────────────────────────────────────────────

test('身份：四条判据各自都能拒（换成"只看 doc_seq"就漏掉三条）', function () {
  const state = M.identity({ realPath: '/r/a.md', generation: 3, docSeq: 7, lineCount: 10, commitSeq: 2 });
  const good = { doc_seq: 7, real_path: '/r/a.md', generation: 3, line_count: 10, commit_seq: 2 };
  assert.strictEqual(M.acceptReply(state, good).ok, true);

  // ① 换文档
  assert.match(M.acceptReply(state, Object.assign({}, good, { doc_seq: 8 })).why, /doc_seq/);
  // ② 同一 doc_seq 下换了文件
  assert.match(M.acceptReply(state, Object.assign({}, good, { real_path: '/r/b.md' })).why, /real_path/);
  // ③ 授权代次变了
  assert.match(M.acceptReply(state, Object.assign({}, good, { generation: 4 })).why, /generation/);
  // ④ ⭐ 行号已陈旧——唯一一条"看起来一切正常"的错法
  assert.match(M.acceptReply(state, Object.assign({}, good, { line_count: 11 })).why, /line_count/);
  // ⑤ commit_seq 倒退
  assert.match(M.acceptReply(state, Object.assign({}, good, { commit_seq: 1 })).why, /commit_seq/);
});

test('身份：回包里没有 real_path / generation 时不据此拒绝（老回包不该被误杀）', function () {
  const state = M.identity({ realPath: '/r/a.md', generation: 3, docSeq: 7, lineCount: 10 });
  assert.strictEqual(M.acceptReply(state, { doc_seq: 7, line_count: 10 }).ok, true);
  // ⚠️ 但 doc_seq 与 line_count **不能**省略。
  assert.strictEqual(M.acceptReply(state, { line_count: 10 }).ok, false);
  assert.strictEqual(M.acceptReply(state, { doc_seq: 7 }).ok, false);
});

test('身份：推进只加 commitSeq 与 lineCount，其余不动', function () {
  const state = M.identity({ realPath: '/r/a.md', generation: 3, docSeq: 7, lineCount: 10 });
  const next = M.advanceIdentity(state, 12);
  assert.deepStrictEqual(
    [next.realPath, next.generation, next.docSeq, next.lineCount, next.commitSeq],
    ['/r/a.md', 3, 7, 12, 1]
  );
});

// ── 提交栈 ─────────────────────────────────────────────────────────────────

test('提交栈：上限丢**最旧**的一条，不是最新的', function () {
  const st = M.createCommitStack(3);
  for (let i = 0; i < 5; i++) st.push({ from: i, to: i + 1, before: ['旧' + i], after: ['新' + i] });
  assert.strictEqual(st.size(), 3);
  assert.deepStrictEqual(
    st.snapshot().map(function (e) {
      return e.after[0];
    }),
    ['新2', '新3', '新4']
  );
});

test('提交栈：条目自相矛盾（`after.length !== to - from`）⇒ 抛错', function () {
  const st = M.createCommitStack(3);
  assert.throws(function () {
    st.push({ from: 0, to: 2, before: ['a'], after: ['x'] });
  }, /自相矛盾/);
});

test('提交栈：`popEdit` 用**条目自己记的** after 长度算右端', function () {
  const st = M.createCommitStack(3);
  st.push({ from: 4, to: 7, before: ['x', 'y'], after: ['X', 'Y', 'Z'] });
  assert.deepStrictEqual(st.popEdit(), { range: { from: 4, to: 7 }, next: ['x', 'y'] });
  assert.strictEqual(st.size(), 0);
  assert.strictEqual(st.popEdit(), null);
});

test('提交栈：onChange 报的是**当前条数**，退订之后不再收到', function () {
  const st = M.createCommitStack(3);
  const seen = [];
  const off = st.onChange(function (n) {
    seen.push(n);
  });
  st.push({ from: 0, to: 1, before: ['a'], after: ['b'] });
  off();
  st.push({ from: 1, to: 2, before: ['c'], after: ['d'] });
  assert.deepStrictEqual(seen, [1]);
});

// ── 两层撤销怎么选 ─────────────────────────────────────────────────────────

test('撤销分派：块视图里有历史 ⇒ 交给 CM6', function () {
  assert.strictEqual(M.resolveUndo({ inBlockView: true, cm6HasHistory: true, commitStackSize: 5 }), 'cm6');
});

test('撤销分派：⭐ 块视图里 CM6 历史**撤到底**也⛔ 不跳去撤提交', function () {
  // 这一条钉的是 `design/0047` §2.6 的"⛔ 不跨层"：CM6 没历史了，
  // 但提交栈非空 ⇒ 结果是 `commit`，而**不是**"这一次 ⌘Z 里先撤字符再撤块"。
  assert.strictEqual(M.resolveUndo({ inBlockView: true, cm6HasHistory: false, commitStackSize: 5 }), 'commit');
});

test('撤销分派：不在块视图 ⇒ 撤最近一次提交；都没了 ⇒ none', function () {
  assert.strictEqual(M.resolveUndo({ inBlockView: false, cm6HasHistory: true, commitStackSize: 2 }), 'commit');
  assert.strictEqual(M.resolveUndo({ inBlockView: false, cm6HasHistory: false, commitStackSize: 0 }), 'none');
  assert.strictEqual(M.resolveUndo(), 'none');
});

test('revertTo：按**逆序**逐条弹，倒到目标条数', function () {
  const st = M.createCommitStack(10);
  let lines = ['a'];
  // 两次提交：a → A → A2
  lines = M.applyEdit(lines, { from: 0, to: 1 }, ['A']);
  st.push({ from: 0, to: 1, before: ['a'], after: ['A'] });
  lines = M.applyEdit(lines, { from: 0, to: 1 }, ['A2']);
  st.push({ from: 0, to: 1, before: ['A'], after: ['A2'] });

  const back = M.revertTo(lines, st, 1);
  assert.deepStrictEqual(back, ['A'], '只倒一条');
  assert.strictEqual(st.size(), 1);
  const all = M.revertTo(back, st, 0);
  assert.deepStrictEqual(all, ['a'], '再倒一条回到最初');
});

// ── 会话：提交 ＋ 撤销 ＋ 重绑 ─────────────────────────────────────────────

test('会话：提交改内存文本与身份，⛔ 一个字节都不写盘（没这个能力）', function () {
  const s = M.createSession({ text: 'a\nb\nc\n', realPath: '/r/a.md', generation: 2, docSeq: 5 });
  assert.strictEqual(s.lineCount(), 4, "`'a\\nb\\nc\\n'` 是 4 行");
  const out = s.commit({ from: 1, to: 2 }, ['B', 'B2']);
  assert.strictEqual(out.fullText, 'a\nB\nB2\nc\n');
  assert.strictEqual(out.lineCount, 5);
  assert.deepStrictEqual(out.identity.lineCount, 5);
  assert.strictEqual(out.identity.commitSeq, 1);
  assert.strictEqual(s.fullText(), 'a\nB\nB2\nc\n');
});

test('会话：提交 → 撤销 ⇒ 文本逐字节回到原样，条数回 0', function () {
  const src = '# 标题\n\n正文\n';
  const s = M.createSession({ text: src, realPath: '/r/a.md', generation: 1, docSeq: 1 });
  s.commit({ from: 2, to: 3 }, ['改过的正文']);
  assert.notStrictEqual(s.fullText(), src);
  const back = s.undo();
  assert.strictEqual(back.fullText, src);
  assert.strictEqual(s.stack().size(), 0);
  // ⚠️ 撤销也是文本变化 ⇒ commitSeq 继续往前走（在途回包必须作废）。
  assert.strictEqual(back.identity.commitSeq, 2);
});

test('会话：栈空时撤销 ⇒ null（⛔ 不臆造一条空编辑）', function () {
  const s = M.createSession({ text: 'a\n', realPath: '/r/a.md', generation: 1, docSeq: 1 });
  assert.strictEqual(s.undo(), null);
});

test('会话：换文档 / 重载 ⇒ 文本与身份换新、栈清空（§2.5 的表）', function () {
  const s = M.createSession({ text: 'a\n', realPath: '/r/a.md', generation: 1, docSeq: 1 });
  s.commit({ from: 0, to: 1 }, ['A']);
  assert.strictEqual(s.stack().size(), 1);

  const ident = s.rebind({ text: 'x\ny\n', realPath: '/r/b.md', docSeq: 2 });
  assert.strictEqual(s.fullText(), 'x\ny\n');
  assert.strictEqual(s.stack().size(), 0, '栈必须清空——旧区间在新文本里没有意义');
  assert.deepStrictEqual(
    [ident.realPath, ident.docSeq, ident.lineCount, ident.commitSeq],
    ['/r/b.md', 2, 3, 0]
  );
  // ⚠️ 只换文本时，real_path / generation 保持不变（外部重载就是这一支）。
  const again = s.rebind({ text: 'x\n' });
  assert.strictEqual(again.realPath, '/r/b.md');
  assert.strictEqual(again.lineCount, 2);
});

test('会话：提交之后的身份能让**旧**回包被拒（陈旧行号的闭环）', function () {
  const s = M.createSession({ text: 'a\nb\n', realPath: '/r/a.md', generation: 1, docSeq: 1 });
  const before = s.identity();
  s.commit({ from: 0, to: 1 }, ['A', 'A2']); // 行数 3→4（含尾部空行）
  const after = s.identity();

  // 旧回包说 3 行 ⇒ 必须被拒（它在说提交之前那份文本）。
  assert.strictEqual(M.acceptReply(after, { doc_seq: 1, line_count: 3 }).ok, false);
  // 同一条回包在提交**之前**是合法的 ⇒ 说明拒它不是"恒假"。
  assert.strictEqual(M.acceptReply(before, { doc_seq: 1, line_count: 3 }).ok, true);
  assert.strictEqual(M.acceptReply(after, { doc_seq: 1, line_count: 4 }).ok, true);
});
