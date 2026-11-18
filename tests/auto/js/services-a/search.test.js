// 文件名搜索的纯逻辑（`src/services/search.js`）的补充用例。
//
// 最值钱的一族是 **UTF-8 字节偏移 → UTF-16 码元**：后端给字节区间，DOM 用码元。
// 落在字符中间的偏移若“就近取整”，高亮会指向用户没搜过的词——而屏幕上不会报错。
//
// ⚠️ 同一 `win` 上先加载 `i18n.js`，再加载 `search.js`：后者在浏览器分支里
//    从 `window.rmd.i18n` 取译者（⛔ 不让它走 `require('./i18n.js')`）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadInto(win, rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // 遮蔽 Node 26 的全局 module / require，强制走 window 分支。
  new Function('window', 'module', 'require', src)(win, undefined, undefined);
}

const win = {};
loadInto(win, 'src/services/i18n.js');
loadInto(win, 'src/services/search.js');
const S = win.rmd.search;

// ─────────────────────────────────────────────────────────────────────────
// UTF-8 字节宽度与换算表
// ─────────────────────────────────────────────────────────────────────────

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

test('byteToUnitTable：ASCII 的字节与码元一一对应', () => {
  const t = S.byteToUnitTable('abc');
  assert.deepStrictEqual(t, [0, 1, 2, 3]);
});

test('byteToUnitTable：中文每字 3 字节、1 个 UTF-16 码元', () => {
  const t = S.byteToUnitTable('中文');
  assert.strictEqual(t[3], 1);
  assert.strictEqual(t[6], 2);
  assert.strictEqual(t.length, 7);
});

test('byteToUnitTable：Emoji 是 4 字节、2 个 UTF-16 码元', () => {
  const t = S.byteToUnitTable('😀');
  assert.strictEqual(t[4], 2);
  assert.strictEqual(t.length, 5);
});

test('byteToUnitTable：只在该码点边界上有值，中间字节查不到', () => {
  const t = S.byteToUnitTable('😀a');
  // 😀 占 4 字节：1/2/3 落在字符中间
  assert.strictEqual(t[1], undefined);
  assert.strictEqual(t[2], undefined);
  assert.strictEqual(t[3], undefined);
  assert.strictEqual(t[4], 2);
  assert.strictEqual(t[5], 3);
});

// ─────────────────────────────────────────────────────────────────────────
// utf16Spans
// ─────────────────────────────────────────────────────────────────────────

test('utf16Spans：ASCII 命中区间原样换算', () => {
  assert.deepStrictEqual(S.utf16Spans('readme.md', [0, 6]), [[0, 6]]);
});

test('utf16Spans：中文命中按码元落点', () => {
  // “说明文档.md” 每个汉字 3 字节；命中前两个汉字
  assert.deepStrictEqual(S.utf16Spans('说明文档.md', [0, 6]), [[0, 2]]);
});

test('utf16Spans：Emoji 命中不整体错位半个字符', () => {
  // 前后各一个 a，Emoji 占 4 字节 → UTF-16 占 2
  assert.deepStrictEqual(S.utf16Spans('a😀b', [1, 5]), [[1, 3]]);
});

test('utf16Spans：落在字符中间的偏移整段丢掉，⛔ 不就近取整', () => {
  assert.deepStrictEqual(S.utf16Spans('中文', [1, 5]), []);
  assert.deepStrictEqual(S.utf16Spans('中a', [0, 1]), [], '结束点落在字符中间');
});

test('utf16Spans：空区间 / 倒序 / 与上一段重叠都丢掉', () => {
  assert.deepStrictEqual(S.utf16Spans('abcdef', [3, 3]), []);
  assert.deepStrictEqual(S.utf16Spans('abcdef', [5, 2]), []);
  assert.deepStrictEqual(S.utf16Spans('abcdef', [0, 4, 2, 5]), [[0, 4]]);
});

test('utf16Spans：奇数长度的扁平数组最后一个被忽略', () => {
  assert.deepStrictEqual(S.utf16Spans('abcdef', [0, 2, 4]), [[0, 2]]);
});

test('utf16Spans：非数组 / 太短 / 非字符串名字都不抛', () => {
  assert.deepStrictEqual(S.utf16Spans('abc', null), []);
  assert.deepStrictEqual(S.utf16Spans('abc', [1]), []);
  assert.deepStrictEqual(S.utf16Spans(null, [0, 1]), []);
});

// ─────────────────────────────────────────────────────────────────────────
// segments
// ─────────────────────────────────────────────────────────────────────────

test('segments：没有命中时是整段未命中', () => {
  assert.deepStrictEqual(S.segments('abc', []), [{ text: 'abc', hit: false }]);
  assert.deepStrictEqual(S.segments('', []), []);
});

test('segments：命中在中间时切成 未命中 / 命中 / 未命中', () => {
  assert.deepStrictEqual(S.segments('readme.md', [[0, 3], [4, 6]]), [
    { text: 'rea', hit: true },
    { text: 'd', hit: false },
    { text: 'me', hit: true },
    { text: '.md', hit: false },
  ]);
});

test('segments：重叠 / 乱序区间拼回去仍与原文逐字相同', () => {
  // 区间不合规时也不许丢字符或重复字符
  const out = S.segments('abcdef', [[2, 5], [4, 7]]);
  assert.strictEqual(out.map((p) => p.text).join(''), 'abcdef');
});

test('segments：非数组 spans 与空名字都不抛', () => {
  assert.deepStrictEqual(S.segments('abc', null), [{ text: 'abc', hit: false }]);
  assert.deepStrictEqual(S.segments(null, []), []);
  assert.deepStrictEqual(S.segments(null, [[0, 1]]), [{ text: '', hit: true }]);
});

// ─────────────────────────────────────────────────────────────────────────
// normalizeResult
// ─────────────────────────────────────────────────────────────────────────

test('normalizeResult：null / 非对象返回 null', () => {
  assert.strictEqual(S.normalizeResult(null), null);
  assert.strictEqual(S.normalizeResult(undefined), null);
  assert.strictEqual(S.normalizeResult('x'), null);
  assert.strictEqual(S.normalizeResult(7), null);
});

test('normalizeResult：版本对读不出来时返回 null（唯一返回 null 的条件）', () => {
  assert.strictEqual(S.normalizeResult({ generation: 1 }), null);
  assert.strictEqual(S.normalizeResult({ req: 1 }), null);
  assert.strictEqual(S.normalizeResult({ req: '1', generation: 1 }), null);
  assert.ok(S.normalizeResult({ req: 1, generation: 1, entries: 'bad' }));
});

test('normalizeResult：没有可打开路径的条目被丢掉', () => {
  const r = S.normalizeResult({
    req: 1, generation: 2,
    entries: [
      null,
      { name: 'a' },
      { name: 'b', real_path: '' },
      { name: 'c', real_path: '/x/c.md' },
    ],
  });
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].realPath, '/x/c.md');
});

test('normalizeResult：字段缺失时容错，不猜也不整包丢弃', () => {
  const r = S.normalizeResult({
    req: 1, generation: 2,
    entries: [{ real_path: '/x/a.md' }],
  });
  assert.deepStrictEqual(r.entries[0], {
    root: '', realPath: '/x/a.md', rel: '', name: '', spans: [],
  });
  assert.strictEqual(r.totalHits, 1, '缺 total_hits 时回落到条目数');
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.builtAtMs, null);
});

test('normalizeResult：roots 只留字符串，truncated 归一成布尔', () => {
  const r = S.normalizeResult({
    req: 1, generation: 2, roots: ['/a', 7, null, '/b'],
    entries: [], truncated: 1,
  });
  assert.deepStrictEqual(r.roots, ['/a', '/b']);
  assert.strictEqual(r.truncated, true);
});

test('commitDecision：形状 / 代次 / 请求号三条分支', () => {
  const cur = { generation: 3, latestSearchReq: 9 };
  assert.deepStrictEqual(S.commitDecision(null, cur), { commit: false, reason: 'shape' });
  assert.deepStrictEqual(
    S.commitDecision({ generation: 2, req: 9 }, cur),
    { commit: false, reason: 'gen' }
  );
  assert.deepStrictEqual(
    S.commitDecision({ generation: 3, req: 8 }, cur),
    { commit: false, reason: 'req' }
  );
  assert.deepStrictEqual(
    S.commitDecision({ generation: 3, req: 9 }, cur),
    { commit: true, reason: null }
  );
});

test('shouldQuery：空串 / 纯空白 / 非字符串都不发 IPC', () => {
  assert.strictEqual(S.shouldQuery(''), false);
  assert.strictEqual(S.shouldQuery('   '), false);
  assert.strictEqual(S.shouldQuery('\t\n'), false);
  assert.strictEqual(S.shouldQuery(null), false);
  assert.strictEqual(S.shouldQuery(7), false);
  assert.strictEqual(S.shouldQuery('a'), true);
  assert.strictEqual(S.shouldQuery('  a  '), true);
});

// ─────────────────────────────────────────────────────────────────────────
// 文案：索引年龄与结果区说明
// ─────────────────────────────────────────────────────────────────────────

test('ageText：四档人话（刚刚 / 秒 / 分钟 / 小时）', () => {
  assert.strictEqual(S.ageText(0), '刚刚');
  assert.strictEqual(S.ageText(999), '刚刚');
  assert.strictEqual(S.ageText(1000), '1 秒前');
  assert.strictEqual(S.ageText(59999), '59 秒前');
  assert.strictEqual(S.ageText(60000), '1 分钟前');
  assert.strictEqual(S.ageText(3599999), '59 分钟前');
  assert.strictEqual(S.ageText(3600000), '1 小时前');
});

test('ageText：负数 / 非数 / 非有限值返回空串，⛔ 不印 NaN', () => {
  assert.strictEqual(S.ageText(-1), '');
  assert.strictEqual(S.ageText(NaN), '');
  assert.strictEqual(S.ageText(Infinity), '');
  assert.strictEqual(S.ageText(null), '');
});

test('summaryText：null 返回空串，零命中说“没有匹配的文件名”', () => {
  assert.strictEqual(S.summaryText(null), '');
  assert.strictEqual(
    S.summaryText({ totalHits: 0, entries: [], builtAtMs: null }),
    '没有匹配的文件名'
  );
});

test('summaryText：截断与总数各说各的', () => {
  assert.strictEqual(
    S.summaryText({ totalHits: 10, entries: [{}, {}], truncated: true, builtAtMs: null }),
    '显示前 2 条（共 10 条）'
  );
  assert.strictEqual(
    S.summaryText({ totalHits: 3, entries: [{}, {}, {}], truncated: false, builtAtMs: null }),
    '3 条'
  );
});

test('summaryText：索引年龄用“ · ”接在后面', () => {
  assert.strictEqual(
    S.summaryText({ totalHits: 0, entries: [], builtAtMs: 500 }),
    '没有匹配的文件名 · 索引 刚刚'
  );
  assert.strictEqual(
    S.summaryText({ totalHits: 0, entries: [], builtAtMs: 61000 }),
    '没有匹配的文件名 · 索引 1 分钟前'
  );
});
