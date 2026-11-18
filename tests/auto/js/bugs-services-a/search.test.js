// 搜索面回归：文件名搜索的纯逻辑（`src/services/search.js`）。
//
// 从历史缺陷出发，守三族**静默**错误：
//   · `0081` 假后端不归一化 BOM/CRLF ⇒ 字节偏移与 UTF-16 码元对不上；
//   · `0009` 搜索提交判据用发请求时的版本 ⇒ 旧结果盖住新结果；
//   · `0019` 索引没重建 ⇒ 新文件搜不到，而那不会报错。
// 核心判据是 **UTF-8 字节偏移 → UTF-16 码元**：落在字符中间必须整段丢掉，
// ⛔ 不就近取整（取整会把高亮指向用户没搜过的词）。
//
// ⚠️ 先加载 `i18n.js` 再加载 `search.js`：后者在浏览器分支里从 `window.rmd.i18n` 取译者。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadInto(win, rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'module', 'require', src)(win, undefined, undefined);
}

const win = {};
loadInto(win, 'src/services/i18n.js');
loadInto(win, 'src/services/search.js');
const S = win.rmd.search;

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0081（假后端不归一化行尾和 BOM 导致探针假红）
// 变体：BOM / CRLF / 中文 / Emoji 混排时字节偏移仍要落到正确码元。
// ─────────────────────────────────────────────────────────────────────────

test('0081/BOM 是 3 个 UTF-8 字节、1 个 UTF-16 码元', () => {
  const t = S.byteToUnitTable('﻿a');
  assert.strictEqual(t[3], 1);
  assert.strictEqual(t[4], 2);
  assert.strictEqual(t.length, 5, '表长 = 字节数 + 1');
  assert.strictEqual(t[1], undefined, 'BOM 中间字节不该有落点');
  assert.strictEqual(t[2], undefined, 'BOM 中间字节不该有落点');
});

test('0081/BOM 之后的命中区间要整体后移 1 个码元', () => {
  assert.deepStrictEqual(S.utf16Spans('﻿中文', [3, 9]), [[1, 3]]);
  assert.deepStrictEqual(S.utf16Spans('﻿中文', [0, 3]), [[0, 1]], '只命中 BOM 本身');
});

test('0081/CRLF 各占 1 字节 1 码元，行尾不改变后续偏移', () => {
  const t = S.byteToUnitTable('a\r\nb');
  assert.deepStrictEqual(t, [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(S.utf16Spans('a\r\nb', [3, 4]), [[3, 4]]);
});

test('0081/CRLF 文件里的中文命中按码元落点，⛔ 不把 \\r 算进字符宽度', () => {
  assert.deepStrictEqual(S.utf16Spans('\r\n说明.md', [2, 8]), [[2, 4]]);
});

test('0081/CRLF 名字的搜索分段逐字拼回原文', () => {
  const name = 'a\r\nb.md';
  const seg = S.segments(name, S.utf16Spans(name, [3, 4]));
  assert.strictEqual(seg.map((p) => p.text).join(''), name);
  assert.deepStrictEqual(seg, [
    { text: 'a\r\n', hit: false },
    { text: 'b', hit: true },
    { text: '.md', hit: false },
  ]);
});

test('0081/中文每字 3 字节 1 码元；全名命中整串', () => {
  assert.deepStrictEqual(S.utf16Spans('说明文档.md', [0, 12]), [[0, 4]]);
  assert.deepStrictEqual(S.utf16Spans('说明文档.md', [0, 6]), [[0, 2]]);
});

test('0081/Emoji 是 4 字节 2 码元，命中不整体错位', () => {
  assert.deepStrictEqual(S.utf16Spans('a😀b', [1, 5]), [[1, 3]]);
  assert.deepStrictEqual(S.utf16Spans('😀', [0, 4]), [[0, 2]]);
});

test('0081/中文 + Emoji + 拉丁混排只在码点边界上换算', () => {
  const name = '中😀a文';
  // 中 3 字节 → 1 码元；😀 4 字节 → 2 码元（3..7）；a 1 字节（7..8）；文 3 字节（8..11）
  assert.deepStrictEqual(S.utf16Spans(name, [0, 7]), [[0, 3]]);
  assert.deepStrictEqual(S.utf16Spans(name, [7, 8]), [[3, 4]]);
  assert.deepStrictEqual(S.utf16Spans(name, [8, 11]), [[4, 5]]);
  assert.deepStrictEqual(S.utf16Spans(name, [3, 5]), [], '落在 😀 中间的区间必须丢掉');
});

test('0081/偏移落在字符中间整段丢掉，⛔ 不就近取整', () => {
  assert.deepStrictEqual(S.utf16Spans('中文', [1, 5]), []);
  assert.deepStrictEqual(S.utf16Spans('中a', [0, 1]), []);
  assert.deepStrictEqual(S.utf16Spans('a中', [2, 3]), []);
});

test('0081/空区间、倒序区间、与前一段重叠都丢掉', () => {
  assert.deepStrictEqual(S.utf16Spans('abcdef', [3, 3]), []);
  assert.deepStrictEqual(S.utf16Spans('abcdef', [5, 2]), []);
  assert.deepStrictEqual(S.utf16Spans('abcdef', [0, 4, 2, 5]), [[0, 4]]);
});

test('0081/奇数长度的扁平数组最后一个偏移被忽略', () => {
  assert.deepStrictEqual(S.utf16Spans('abcdef', [0, 2, 4]), [[0, 2]]);
});

test('0081/名字不是字符串 / 区间不是数组时不抛', () => {
  assert.deepStrictEqual(S.utf16Spans(null, [0, 1]), []);
  assert.deepStrictEqual(S.utf16Spans('abc', null), []);
  assert.deepStrictEqual(S.utf16Spans(undefined, [1]), []);
});

test('0081/隐藏文件 .md 的命中只亮第一个点，不把整名当扩展名', () => {
  assert.deepStrictEqual(S.segments('.md', S.utf16Spans('.md', [0, 1])), [
    { text: '.', hit: true },
    { text: 'md', hit: false },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0009（文件名搜索的提交判据）
// 变体：旧代次 / 旧请求号的回包一律不落地。
// ─────────────────────────────────────────────────────────────────────────

test('0009/版本对读不出来时整包返回 null（唯一返回 null 的条件）', () => {
  assert.strictEqual(S.normalizeResult({ generation: 1 }), null);
  assert.strictEqual(S.normalizeResult({ req: 1 }), null);
  assert.strictEqual(S.normalizeResult({ req: '1', generation: 1 }), null);
});

test('0009/没有可打开路径的条目不显示（点不动比少一条更糟）', () => {
  const r = S.normalizeResult({
    req: 1, generation: 2,
    entries: [null, { name: 'a' }, { real_path: '' }, { real_path: '/x/c.md' }],
  });
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].realPath, '/x/c.md');
});

test('0009/字段缺失时容错，不整包丢掉', () => {
  const r = S.normalizeResult({ req: 1, generation: 2, entries: [{ real_path: '/x/a.md' }] });
  assert.deepStrictEqual(r.entries[0], {
    root: '', realPath: '/x/a.md', rel: '', name: '', spans: [],
  });
  assert.strictEqual(r.totalHits, 1);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.builtAtMs, null);
});

test('0009/roots 只留字符串，truncated 归一成布尔', () => {
  const r = S.normalizeResult({
    req: 1, generation: 2, roots: ['/a', 7, null, '/b'], entries: [], truncated: 1,
  });
  assert.deepStrictEqual(r.roots, ['/a', '/b']);
  assert.strictEqual(r.truncated, true);
});

test('0009/不同 root 下的同名文件各留一条，顺序按后端返回', () => {
  const r = S.normalizeResult({
    req: 3, generation: 7,
    entries: [
      { real_path: '/a/同名.md', name: '同名.md' },
      { real_path: '/b/同名.md', name: '同名.md' },
    ],
  });
  assert.deepStrictEqual(r.entries.map((e) => e.realPath), ['/a/同名.md', '/b/同名.md']);
  assert.deepStrictEqual(r.entries[0].spans, []);
});

test('0009/提交判据：形状不对 / 代次不符 / 请求号不符 / 全对', () => {
  const cur = { generation: 3, latestSearchReq: 9 };
  assert.deepStrictEqual(S.commitDecision(null, cur), { commit: false, reason: 'shape' });
  assert.deepStrictEqual(S.commitDecision({ generation: 2, req: 9 }, cur),
    { commit: false, reason: 'gen' });
  assert.deepStrictEqual(S.commitDecision({ generation: 3, req: 8 }, cur),
    { commit: false, reason: 'req' });
  assert.deepStrictEqual(S.commitDecision({ generation: 3, req: 9 }, cur),
    { commit: true, reason: null });
});

test('0009/提交判据在提交那一刻现取：请求发出后请求号变了就丢弃', () => {
  const result = { generation: 1, req: 4 };
  assert.strictEqual(S.commitDecision(result, { generation: 1, latestSearchReq: 4 }).commit, true);
  assert.strictEqual(S.commitDecision(result, { generation: 1, latestSearchReq: 5 }).commit, false);
});

test('0009/空模式 / 纯空白 / 非字符串不发 IPC', () => {
  for (const p of ['', '   ', '\t\n', ' ', '　', null, 7]) {
    assert.strictEqual(S.shouldQuery(p), false, JSON.stringify(p));
  }
  assert.strictEqual(S.shouldQuery('a'), true);
  assert.strictEqual(S.shouldQuery(' 中 '), true);
});

test('0019/新文件的名字能正常切段：命中在中文名前缀', () => {
  const name = '新建文档.md';
  assert.deepStrictEqual(S.segments(name, S.utf16Spans(name, [0, 6])), [
    { text: '新建', hit: true },
    { text: '文档.md', hit: false },
  ]);
});

test('0009/分段：重叠 / 乱序区间拼回去仍与原文逐字相同', () => {
  const out = S.segments('abcdef', [[2, 5], [4, 7]]);
  assert.strictEqual(out.map((p) => p.text).join(''), 'abcdef');
});

test('0009/分段：非数组 spans 与空名字都不抛', () => {
  assert.deepStrictEqual(S.segments('abc', null), [{ text: 'abc', hit: false }]);
  assert.deepStrictEqual(S.segments(null, []), []);
  assert.deepStrictEqual(S.segments(null, [[0, 1]]), [{ text: '', hit: true }]);
});

test('0009/索引年龄四档人话，负数 / 非数不印 NaN', () => {
  assert.strictEqual(S.ageText(0), '刚刚');
  assert.strictEqual(S.ageText(999), '刚刚');
  assert.strictEqual(S.ageText(1000), '1 秒前');
  assert.strictEqual(S.ageText(59999), '59 秒前');
  assert.strictEqual(S.ageText(60000), '1 分钟前');
  assert.strictEqual(S.ageText(3599999), '59 分钟前');
  assert.strictEqual(S.ageText(3600000), '1 小时前');
  for (const v of [-1, NaN, Infinity, null]) assert.strictEqual(S.ageText(v), '');
});

test('0009/结果区说明：零命中 / 截断 / 普通计数 / 索引年龄', () => {
  assert.strictEqual(S.summaryText(null), '');
  assert.strictEqual(S.summaryText({ totalHits: 0, entries: [], builtAtMs: null }),
    '没有匹配的文件名');
  assert.strictEqual(S.summaryText({ totalHits: 10, entries: [{}, {}], truncated: true, builtAtMs: null }),
    '显示前 2 条（共 10 条）');
  assert.strictEqual(S.summaryText({ totalHits: 3, entries: [{}, {}, {}], truncated: false, builtAtMs: null }),
    '3 条');
  assert.strictEqual(S.summaryText({ totalHits: 0, entries: [], builtAtMs: 61000 }),
    '没有匹配的文件名 · 索引 1 分钟前');
});

test('utf8Len 四个区间的边界都对', () => {
  assert.strictEqual(S.utf8Len(0x00), 1);
  assert.strictEqual(S.utf8Len(0x7f), 1);
  assert.strictEqual(S.utf8Len(0x80), 2);
  assert.strictEqual(S.utf8Len(0x7ff), 2);
  assert.strictEqual(S.utf8Len(0x800), 3);
  assert.strictEqual(S.utf8Len(0xffff), 3);
  assert.strictEqual(S.utf8Len(0x10000), 4);
  assert.strictEqual(S.utf8Len(0x10ffff), 4);
});

test('byteToUnitTable：ASCII 一一对应，只在码点边界有值', () => {
  assert.deepStrictEqual(S.byteToUnitTable('abc'), [0, 1, 2, 3]);
  const t = S.byteToUnitTable('😀a');
  assert.strictEqual(t[1], undefined);
  assert.strictEqual(t[2], undefined);
  assert.strictEqual(t[3], undefined);
  assert.strictEqual(t[4], 2);
  assert.strictEqual(t[5], 3);
});
