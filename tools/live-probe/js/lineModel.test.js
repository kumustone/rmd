'use strict';

// ⭐ 关键契约 1「行号 splice 是否真的无损」的 **JS 半**（`docs/design/0047` §2.4）。
//
// ⚠️ Rust 半（`tools/live-probe` 的 `--fixtures`）证的是**块表本身**：
//    每块的行区间切出来重新 parse 还是同一块，且「块 ∪ 块间行」恰好盖满全文。
// JS 半证的是**提交那一步**：把这个区间换掉之后，全文与块表仍然自洽。
// ⛔ 两半不能互相替代——Rust 没有前端的行数组，JS 没有 comrak。

const test = require('node:test');
const assert = require('node:assert');

const M = require('./lineModel');

const FIXTURES = [
  {
    name: '空行分隔的两段',
    text: 'para one\n\npara two\n',
    blocks: [
      { index: 0, kind: 'Paragraph', start_line: 1, end_line: 1 },
      { index: 1, kind: 'Paragraph', start_line: 3, end_line: 3 },
    ],
    gaps: [2, 4],
  },
  {
    name: '末尾连续空行',
    text: 'a\n\n\n',
    blocks: [{ index: 0, kind: 'Paragraph', start_line: 1, end_line: 1 }],
    gaps: [2, 3, 4],
  },
  {
    name: '无尾换行（软换行连成一段）',
    text: 'a\nb',
    blocks: [{ index: 0, kind: 'Paragraph', start_line: 1, end_line: 2 }],
    gaps: [],
  },
  {
    name: '隐藏指令 [TOC] 落在块间',
    text: '[TOC]\n\n# 标题\n\n正文\n',
    blocks: [
      { index: 0, kind: 'Heading', start_line: 3, end_line: 3 },
      { index: 1, kind: 'Paragraph', start_line: 5, end_line: 5 },
    ],
    gaps: [1, 2, 4, 6],
  },
  {
    name: '引用定义行落在块间',
    text: '见[引用][a]。\n\n[a]: https://example.com\n\n下一段\n',
    blocks: [
      { index: 0, kind: 'Paragraph', start_line: 1, end_line: 1 },
      { index: 1, kind: 'Paragraph', start_line: 5, end_line: 5 },
    ],
    gaps: [2, 3, 4, 6],
  },
  {
    name: '围栏代码块内含空行',
    text: '```rust\nfn a() {}\n\nfn b() {}\n```\n紧跟段落\n',
    blocks: [
      { index: 0, kind: 'CodeBlock', start_line: 1, end_line: 5 },
      { index: 1, kind: 'Paragraph', start_line: 6, end_line: 6 },
    ],
    gaps: [7],
  },
  {
    name: '宽松列表项间空行属于列表块',
    text: '- 一\n\n- 二\n',
    blocks: [{ index: 0, kind: 'List', start_line: 1, end_line: 3 }],
    gaps: [4],
  },
  {
    name: 'Setext 标题两行一块',
    text: '标题\n===\n\n正文\n',
    blocks: [
      { index: 0, kind: 'Heading', start_line: 1, end_line: 2 },
      { index: 1, kind: 'Paragraph', start_line: 4, end_line: 4 },
    ],
    gaps: [3, 5],
  },
];

test('行模型·行数口径', async (t) => {
  await t.test('末尾换行会多出一个空行元素', () => {
    assert.deepStrictEqual(M.splitLines('a\n'), ['a', '']);
    assert.strictEqual(M.splitLines('a\n').length, 2);
  });
  await t.test('无尾换行不多一个', () => {
    assert.deepStrictEqual(M.splitLines('a'), ['a']);
  });
  await t.test('空文件是 1 行（一个空串），⛔ 不是 0 行', () => {
    assert.deepStrictEqual(M.splitLines(''), ['']);
  });
  await t.test('join/split 往返逐字', () => {
    for (const f of FIXTURES) {
      assert.strictEqual(M.joinLines(M.splitLines(f.text)), f.text, f.name);
    }
  });
  // ⚠️ 变异自证：把 split 改成按行尾符号计数，这条会红
  await t.test('变异检查：`\\n` 计数 ≠ 行数', () => {
    const t1 = 'a\nb\n';
    assert.strictEqual(t1.split('\n').length, 3);
    assert.strictEqual((t1.match(/\n/g) || []).length, 2);
  });
});

test('行模型·1-based 含两端 ⇄ 0-based 半开', async (t) => {
  await t.test('单行 1-1 ⇒ [0,1)', () => {
    assert.deepStrictEqual(M.toRange(1, 1), { from: 0, to: 1 });
  });
  await t.test('三行 3-5 ⇒ [2,5)', () => {
    assert.deepStrictEqual(M.toRange(3, 5), { from: 2, to: 5 });
  });
  await t.test('区间倒置抛错', () => {
    assert.throws(() => M.toRange(3, 2), /非法/);
  });
  await t.test('行号 0 抛错（1-based 没有 0 行）', () => {
    assert.throws(() => M.toRange(0, 1), /非法/);
  });
  await t.test('非整数抛错', () => {
    assert.throws(() => M.toRange(1.5, 2), /整数/);
  });
});

test('行模型·块表与块间行（与 Rust 夹具同口径）', async (t) => {
  for (const f of FIXTURES) {
    await t.test(f.name, () => {
      const lines = M.splitLines(f.text);
      assert.deepStrictEqual(M.spanIssues(lines.length, f.blocks), [], '结构');
      assert.deepStrictEqual(M.gapsOf(lines.length, f.blocks), f.gaps, '块间行');
      // 覆盖：块内行数 + 块间行数 === 总行数
      const covered = f.blocks.reduce((n, b) => n + (b.end_line - b.start_line + 1), 0);
      assert.strictEqual(covered + f.gaps.length, lines.length, '覆盖');
    });
  }

  await t.test('重叠必须被抓到', () => {
    const bad = [
      { index: 0, kind: 'P', start_line: 1, end_line: 3 },
      { index: 1, kind: 'P', start_line: 3, end_line: 4 },
    ];
    assert.match(M.spanIssues(5, bad)[0], /重叠/);
  });
  await t.test('越界必须被抓到', () => {
    const bad = [{ index: 0, kind: 'P', start_line: 1, end_line: 9 }];
    assert.match(M.spanIssues(5, bad)[0], /超出/);
  });
});

test('提交·按行号 splice 无损', async (t) => {
  await t.test('块内插入一行 ⇒ 下游行号整体下移，其余逐字不变', () => {
    const lines = M.splitLines('para one\n\npara two\n');
    const range = M.toRange(1, 1);
    const out = M.applyEdit(lines, range, ['para one', '续行']);
    assert.deepStrictEqual(out, ['para one', '续行', '', 'para two', '']);
    // 尾段（原第 2 行起）逐字未变
    assert.deepStrictEqual(out.slice(3), lines.slice(2));
  });

  await t.test('跨块合并：删掉分隔空行 ⇒ 只剩 3 行', () => {
    const lines = M.splitLines('para one\n\npara two\n');
    const out = M.applyEdit(lines, M.toRange(2, 2), []);
    assert.strictEqual(M.joinLines(out), 'para one\npara two\n');
  });

  await t.test('整块删除：区间换成空数组', () => {
    const lines = M.splitLines('a\n\nb\n');
    const out = M.applyEdit(lines, M.toRange(3, 3), []);
    assert.strictEqual(M.joinLines(out), 'a\n\n');
  });

  await t.test('末尾追加空行', () => {
    const lines = M.splitLines('a');
    const out = M.applyEdit(lines, { from: 1, to: 1 }, ['']);
    assert.strictEqual(M.joinLines(out), 'a\n');
  });

  await t.test('隐藏指令不在被编辑块内 ⇒ 逐字保留', () => {
    const lines = M.splitLines('[TOC]\n\n# 标题\n\n正文\n');
    const out = M.applyEdit(lines, M.toRange(3, 3), ['## 改过的标题']);
    assert.strictEqual(out[0], '[TOC]');
    assert.strictEqual(out[2], '## 改过的标题');
  });

  await t.test('引用定义不在被编辑块内 ⇒ 逐字保留', () => {
    const lines = M.splitLines('见[引用][a]。\n\n[a]: https://example.com\n\n下一段\n');
    const out = M.applyEdit(lines, M.toRange(1, 1), ['改过的[引用][a]。']);
    assert.strictEqual(out[2], '[a]: https://example.com');
  });

  await t.test('越界抛错，⛔ 不静默夹取', () => {
    const lines = M.splitLines('a\nb\n');
    assert.throws(() => M.applyEdit(lines, { from: 0, to: 9 }, ['x']), /越界/);
  });

  // ⭐⭐ 这条是"无损"的**真正含义**：对任意块、任意替换，只要新行数与原块行数无关于
  //      其它块，那么**其它块的那几行**在新全文里仍然逐字在（只是行号可能变）。
  await t.test('任意单块替换 ⇒ 其它块的行内容逐字仍在', () => {
    for (const f of FIXTURES) {
      const lines = M.splitLines(f.text);
      for (const target of f.blocks) {
        const others = f.blocks
          .filter((b) => b !== target)
          .map((b) => lines.slice(b.start_line - 1, b.end_line));
        const out = M.applyEdit(lines, M.toRange(target.start_line, target.end_line), ['替换']);
        for (const rows of others) {
          const joined = rows.join('\n');
          assert.ok(
            M.joinLines(out).includes(joined),
            `${f.name}：替换块 ${target.index} 之后丢了别的块内容 ${JSON.stringify(joined)}`
          );
        }
      }
    }
  });
});

test('身份闸·陈旧行号必须被拒', async (t) => {
  await t.test('行数变了 ⇒ 旧回包被拒（这就是四件套里 line_count 的作用）', () => {
    const state = { doc_seq: 7, line_count: 4, commit_seq: 3 };
    assert.deepStrictEqual(M.acceptReply(state, { doc_seq: 7, line_count: 4, commit_seq: 3 }), {
      ok: true,
      why: '',
    });
    const r = M.acceptReply(state, { doc_seq: 7, line_count: 4, commit_seq: 2 });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /commit_seq 倒退/);

    const next = M.afterCommit(state, 5);
    assert.strictEqual(next.line_count, 5);
    assert.strictEqual(next.commit_seq, 4);
    const stale = M.acceptReply(next, { doc_seq: 7, line_count: 4, commit_seq: 4 });
    assert.strictEqual(stale.ok, false);
    assert.match(stale.why, /行号已陈旧/);
  });

  await t.test('换文档（doc_seq 变）⇒ 一律作废', () => {
    const state = { doc_seq: 1, line_count: 10, commit_seq: 0 };
    const r = M.acceptReply(state, { doc_seq: 2, line_count: 10, commit_seq: 0 });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /doc_seq/);
  });

  // ⭐ 反证：只比 doc_seq 是不够的
  await t.test('⚠️ 仅 doc_seq 相同不足以判新——行数变化才是真正的危险', () => {
    const state = { doc_seq: 7, line_count: 5, commit_seq: 1 };
    const staleReply = { doc_seq: 7, line_count: 9, commit_seq: 1 };
    // 若实现只比 doc_seq，这条会被当成有效 ⇒ 把 9 行文档的块表贴到 5 行文档上
    assert.strictEqual(M.acceptReply(state, staleReply).ok, false);
  });
});

test('定位·块间行点不出块', async (t) => {
  const text = '[TOC]\n\n# 标题\n';
  const lines = M.splitLines(text);
  const blocks = [{ index: 0, kind: 'Heading', start_line: 3, end_line: 3 }];
  assert.strictEqual(M.locateBlock(blocks, 1), null, '[TOC] 那行不是块');
  assert.strictEqual(M.locateBlock(blocks, 2), null, '空行不是块');
  assert.strictEqual(M.locateBlock(blocks, 3).kind, 'Heading');
  assert.strictEqual(lines.length, 4);
});
