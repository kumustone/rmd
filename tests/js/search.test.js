// `design/0009` §7 的单测：**搜索的纯逻辑**（字节→UTF-16 换算 / 提交判据 / 响应形状）。
//
// ⭐ 这一格测的**不是匹配算法**（那在 Rust 侧，`fs/tree.rs` 有它自己的 24 条）。
//    这里测的是前端唯一真正要动脑子的那一段：
//
// ① ⭐ **UTF-8 字节 → UTF-16 码元**（`INV-SEARCH-03` 的后半句）。
//    ⚠️ 这是本项目最容易静默出错的地方，而且**英文语料测不出来**：
//    ASCII 名字上"字节下标 == 码元下标"，中文名字会**切进字符中间**，
//    Emoji 更会整体错位（1 个 code point = 4 字节 = **2 个** UTF-16 码元）。
//    ⇒ 断言必须包含**反例**（落在字符中间的偏移要**丢掉**），
//    ⛔ 只测"中文名命中"是不够的——那一路写错了也常常碰巧对。
// ② **提交判据**（`req` / 代次，§2.1 ⑥）：三条分支各来一条。
// ③ **响应形状归一**（§2.1 ②.1）：后端 serde 的名字 → 前端形状。
//    ⚠️ 判据是"少一条结果 ≠ 显示一条错的"——所以没有 `real_path` 的条目是被**丢掉**的。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Se = require('../../src/services/search.js');

// ─────────────────────────────────────────────────────────────────────────
// ① 字节 → UTF-16
// ─────────────────────────────────────────────────────────────────────────

test('utf8Len_四个区间的边界都对', function () {
  assert.strictEqual(Se.utf8Len(0x41), 1);      // 'A'
  assert.strictEqual(Se.utf8Len(0x7f), 1);
  assert.strictEqual(Se.utf8Len(0x80), 2);      // 'é'
  assert.strictEqual(Se.utf8Len(0x7ff), 2);
  assert.strictEqual(Se.utf8Len(0x800), 3);     // '会'
  assert.strictEqual(Se.utf8Len(0xffff), 3);
  assert.strictEqual(Se.utf8Len(0x10000), 4);   // '😀' 起
});

test('字节表只在码点边界上有值_中间的偏移查不到', function () {
  // 'a会'：'a' 占 1 字节，'会' 占 3 字节
  const t = Se.byteToUnitTable('a会');
  assert.strictEqual(t[0], 0);
  assert.strictEqual(t[1], 1);   // '会' 的起点
  assert.strictEqual(t[4], 2);   // 结束
  // ⚠️ 2 / 3 落在 '会' 的三个字节**中间** ⇒ 必须是 `undefined`。
  //    真有值时，`utf16Spans` 就会"就近取整"，把高亮切进字符里。
  assert.strictEqual(t[2], undefined);
  assert.strictEqual(t[3], undefined);
});

test('Emoji_是一个码点两个_UTF16_码元_四个字节', function () {
  // ⚠️ 三种计法都能"看起来对"地写出来，只有一种是对的：
  //    按 UTF-16 码元迭代 → 代理对会被数成两个 3 字节字符；
  //    按 char 数（Rust 的 chars().count()）→ 这里是 1，但 UTF-16 要占 2。
  const t = Se.byteToUnitTable('😀b');
  assert.strictEqual(t[0], 0);
  assert.strictEqual(t[4], 2, '😀 占 2 个 UTF-16 码元');
  assert.strictEqual(t[5], 3);
});

test('中文命中_区间逐码元正确', function () {
  // '会议纪要.md' 的字节：会 0..3 / 议 3..6 / 纪 6..9 / 要 9..12 / . 12..13 …
  // 后端给的 `match` 是**原串上的 UTF-8 字节区间**（`INV-SEARCH-03`）。
  const spans = Se.utf16Spans('会议纪要.md', [6, 12]);
  assert.deepStrictEqual(spans, [[2, 4]]);
  assert.deepStrictEqual(Se.segments('会议纪要.md', spans), [
    { text: '会议', hit: false },
    { text: '纪要', hit: true },
    { text: '.md', hit: false },
  ]);
});

test('Emoji_命中_不整体错位半个字符', function () {
  const spans = Se.utf16Spans('a😀b.md', [1, 5]);
  assert.deepStrictEqual(spans, [[1, 3]]);
  assert.deepStrictEqual(Se.segments('a😀b.md', spans), [
    { text: 'a', hit: false },
    { text: '😀', hit: true },
    { text: 'b.md', hit: false },
  ]);
});

test('落在字符中间的偏移_整段丢掉_不就近取整', function () {
  // ⚠️ 这是**反例**那一条：`[1,3]` 的 1 与 3 都落在 '会'（0..3）内部/边界上？
  //    1 与 2 在内部，3 恰好是下一个码点的起点。
  //    ⇒ 起点查不到 ⇒ **整段丢掉**。
  //    ⛔ 若"就近取整"，高亮会指向一个用户**没搜过**的词——那比不显示更糟。
  assert.deepStrictEqual(Se.utf16Spans('会议纪要.md', [1, 3]), []);
  assert.deepStrictEqual(Se.utf16Spans('会议纪要.md', [6, 7]), []);
});

test('空区间_倒序_重叠_都丢掉', function () {
  assert.deepStrictEqual(Se.utf16Spans('abcd.md', [2, 2]), [], '空区间');
  assert.deepStrictEqual(Se.utf16Spans('abcd.md', [3, 1]), [], '倒序');
  // 第二段与第一段重叠（[0,3) 与 [2,5)）⇒ 只保留第一段
  assert.deepStrictEqual(Se.utf16Spans('abcd.md', [0, 3, 2, 5]), [[0, 3]]);
  // 越界（名字只有 7 个 ASCII 字节）
  assert.deepStrictEqual(Se.utf16Spans('abcd.md', [0, 99]), []);
});

test('形状不合的_match_一律当没有命中_不抛', function () {
  // ⚠️ 跨语言契约，`match` 是**不可信**输入：宁可整条不高亮，
  //    ⛔ 也不能让一份奇怪的响应把结果区打不开。
  assert.deepStrictEqual(Se.utf16Spans('a.md', null), []);
  assert.deepStrictEqual(Se.utf16Spans('a.md', 'x'), []);
  assert.deepStrictEqual(Se.utf16Spans('a.md', [1]), []);
  assert.deepStrictEqual(Se.utf16Spans(null, [0, 1]), []);
});

test('segments_没有命中时是整段_全覆盖时也只有一段', function () {
  assert.deepStrictEqual(Se.segments('a.md', []), [{ text: 'a.md', hit: false }]);
  assert.deepStrictEqual(Se.segments('a.md', [[0, 4]]), [{ text: 'a.md', hit: true }]);
  // 空名字也要能跑（后端理论上不会给，但它是用户数据）
  assert.deepStrictEqual(Se.segments('', []), []);
});

// ─────────────────────────────────────────────────────────────────────────
// ② 响应形状归一（§2.1 ②.1）
// ─────────────────────────────────────────────────────────────────────────

/** 一份**形状正确**的响应。各条用例只改自己关心的那个字段。 */
function raw(over) {
  const base = {
    generation: 7,
    req: 3,
    roots: ['/tmp/docs'],
    entries: [
      { root: '/tmp/docs', real_path: '/tmp/docs/会议纪要.md', rel: '会议纪要.md', name: '会议纪要.md', match: [6, 12] },
    ],
    total_hits: 1,
    truncated: false,
    built_at_ms: 12,
  };
  return Object.assign(base, over || {});
}

test('形状读不出来时返回_null_只有这一种情况', function () {
  // ⚠️ 返回 `null` 的条件**只有一条**：版本对读不出来。
  //    那时连"该不该显示"都判不了。
  assert.strictEqual(Se.normalizeResult(null), null);
  assert.strictEqual(Se.normalizeResult('x'), null);
  assert.strictEqual(Se.normalizeResult({ req: 1 }), null, '缺 generation');
  assert.strictEqual(Se.normalizeResult({ generation: 1 }), null, '缺 req');
});

test('归一化_把_match_换算成区间_并保留全部字段', function () {
  const r = Se.normalizeResult(raw());
  assert.strictEqual(r.generation, 7);
  assert.strictEqual(r.req, 3);
  assert.deepStrictEqual(r.roots, ['/tmp/docs']);
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].realPath, '/tmp/docs/会议纪要.md');
  assert.strictEqual(r.entries[0].name, '会议纪要.md');
  assert.deepStrictEqual(r.entries[0].spans, [[2, 4]], '⚠️ 这里已经是 UTF-16 区间');
  assert.strictEqual(r.totalHits, 1);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.builtAtMs, 12);
});

test('没有可打开路径的条目被丢掉_一条点不动的结果比少一条更糟', function () {
  const r = Se.normalizeResult(raw({
    entries: [
      { real_path: '/a.md', name: 'a.md', match: [0, 1] },
      { real_path: '', name: 'b.md', match: [0, 1] },      // 空路径
      { name: 'c.md', match: [0, 1] },                     // 没有 real_path
      null, 42,                                            // 根本不是对象
    ],
  }));
  assert.deepStrictEqual(r.entries.map(function (e) { return e.name; }), ['a.md']);
});

test('缺字段时容错_不让 200 条结果全不显示', function () {
  const r = Se.normalizeResult(raw({
    roots: 'x',
    entries: [{ real_path: '/a.md' }],   // 连 name 都没有
    total_hits: undefined,
    truncated: 'yes',
    built_at_ms: undefined,
  }));
  assert.deepStrictEqual(r.roots, []);
  assert.strictEqual(r.entries[0].name, '');
  assert.deepStrictEqual(r.entries[0].spans, []);
  assert.strictEqual(r.totalHits, 1, '⚠️ 缺 total_hits 时退成实际条数，⛔ 不是 0');
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.builtAtMs, null);
});

test('truncated_落到那一行说明上', function () {
  const r = Se.normalizeResult(raw({ entries: [raw().entries[0], raw().entries[0]], total_hits: 5000, truncated: true }));
  const s = Se.summaryText(r);
  assert.ok(/显示前 2 条（共 5000 条）/.test(s), s);
  assert.ok(/索引 /.test(s), '索引年龄要一起说：' + s);
});

test('一条都没命中与空索引是两种说法', function () {
  assert.strictEqual(Se.summaryText(Se.normalizeResult(raw({ entries: [], total_hits: 0 }))).indexOf('没有匹配'), 0);
  assert.strictEqual(Se.summaryText(null), '');
});

test('ageText_四档都在', function () {
  assert.strictEqual(Se.ageText(200), '刚刚');
  assert.strictEqual(Se.ageText(3000), '3 秒前');
  assert.strictEqual(Se.ageText(90 * 1000), '1 分钟前');
  assert.strictEqual(Se.ageText(2 * 3600 * 1000), '2 小时前');
  // ⚠️ 读不出来时返回**空串**（调用方会跳过那一段），⛔ 不是 "null 秒前"
  assert.strictEqual(Se.ageText(undefined), '');
  assert.strictEqual(Se.ageText(-1), '');
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 提交判据（§2.1 ⑥）
// ─────────────────────────────────────────────────────────────────────────

test('提交判据_三条分支与一条通过', function () {
  const r = Se.normalizeResult(raw());
  const now = { generation: 7, latestSearchReq: 3 };
  assert.deepStrictEqual(Se.commitDecision(r, now), { commit: true, reason: null });
  // 读不懂的响应
  assert.deepStrictEqual(Se.commitDecision(null, now), { commit: false, reason: 'shape' });
  // ⭐ 切根了：**必须丢掉**，⛔ 不是"留着旧的"（§2.1 ⑥ 明文要求）
  assert.deepStrictEqual(Se.commitDecision(r, { generation: 8, latestSearchReq: 3 }),
    { commit: false, reason: 'gen' });
  // ⭐ 更新的一次请求已经在路上（`req` 是**发出去时**现取的，⛔ 不是回来时）
  assert.deepStrictEqual(Se.commitDecision(r, { generation: 7, latestSearchReq: 4 }),
    { commit: false, reason: 'req' });
});

test('空模式不发查询_纯空白也不算', function () {
  assert.strictEqual(Se.shouldQuery(''), false);
  assert.strictEqual(Se.shouldQuery('   '), false);
  assert.strictEqual(Se.shouldQuery('\t\n'), false);
  assert.strictEqual(Se.shouldQuery(null), false);
  assert.strictEqual(Se.shouldQuery('a'), true);
  assert.strictEqual(Se.shouldQuery('  会 '), true, '⚠️ 前后有空白但内容非空 ⇒ 要搜');
});
