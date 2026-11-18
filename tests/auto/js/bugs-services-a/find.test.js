// 正文内查找的纯逻辑（`src/services/find.js`, `design/0011`）。
//
// 从历史缺陷出发，守三族**静默**错误：
//   · `0002` / `0011` 族：搜索域混进源码标记或公式内容 —— 命中数看着正常，
//     框出来的却是屏幕上不存在的话；
//   · 排版空白被当成截断点 —— 行内元素之间凭空断开，跨 `<br>` 反而能命中；
//   · 计数被高亮上限截断 —— 明明有 40 万处，浮层上只敢说"2 000"。
// 另外守 UTF-16 偏移与代理对：切出半个 Emoji 的关键词永远匹配不上。
//
// ⚠️ 先加载 `i18n.js`：`find.js` 在浏览器分支里加载期取 `window.rmd.i18n`。
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
loadInto(win, 'src/services/find.js');
const F = win.rmd.find;

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0002（查找搜索域：屏幕上写的才能搜到）
// 变体：关键词归一、非重叠、字面匹配、跨段不合并。
// ─────────────────────────────────────────────────────────────────────────

test('0002/normalizeQuery：只有空白等于没输入', () => {
  for (const q of ['', ' ', '\t', '\n', '　', ' ', ' \t\n　']) {
    assert.strictEqual(F.normalizeQuery(q), '', JSON.stringify(q));
  }
});

test('0002/normalizeQuery：非空关键词原样保留，⛔ 不替用户裁掉首尾空格', () => {
  assert.strictEqual(F.normalizeQuery(' 中 '), ' 中 ');
  assert.strictEqual(F.normalizeQuery('a b'), 'a b');
  assert.strictEqual(F.normalizeQuery('  '), '');
});

test('0002/normalizeQuery：null / undefined / 数字都能安全转成串', () => {
  assert.strictEqual(F.normalizeQuery(null), '');
  assert.strictEqual(F.normalizeQuery(undefined), '');
  assert.strictEqual(F.normalizeQuery(0), '0');
  assert.strictEqual(F.normalizeQuery(42), '42');
});

test('0002/matchAll：非重叠匹配与源域同口径（aaaa 搜 aa 是 2 处，不是 3 处）', () => {
  assert.deepStrictEqual(F.matchAll(['aaaa'], 'aa'), [
    { seg: 0, start: 0, end: 2 },
    { seg: 0, start: 2, end: 4 },
  ]);
});

test('0002/matchAll：按段序、段内先后返回，⛔ 不跨段合并', () => {
  assert.deepStrictEqual(F.matchAll(['甲乙', '甲丙甲'], '甲'), [
    { seg: 0, start: 0, end: 1 },
    { seg: 1, start: 0, end: 1 },
    { seg: 1, start: 2, end: 3 },
  ]);
});

test('0002/matchAll：偏移是 UTF-16 码元，Emoji 算两个位置', () => {
  assert.deepStrictEqual(F.matchAll(['😀x'], 'x'), [{ seg: 0, start: 2, end: 3 }]);
  assert.deepStrictEqual(F.matchAll(['a😀b'], '😀'), [{ seg: 0, start: 1, end: 3 }]);
});

test('0002/matchAll：正则元字符按字面匹配（⛔ 不把用户输入当表达式）', () => {
  assert.deepStrictEqual(F.matchAll(['a.b(c)'], '.'), [{ seg: 0, start: 1, end: 2 }]);
  assert.deepStrictEqual(F.matchAll(['a.b(c)'], 'b('), [{ seg: 0, start: 2, end: 4 }]);
  assert.deepStrictEqual(F.matchAll(['a*b'], '.*'), []);
  assert.deepStrictEqual(F.matchAll(['a.*b'], '.*'), [{ seg: 0, start: 1, end: 3 }]);
});

test('0002/matchAll：空查询 / 纯空白查询一个命中都没有', () => {
  assert.deepStrictEqual(F.matchAll(['abc'], ''), []);
  assert.deepStrictEqual(F.matchAll(['abc'], '   '), []);
  assert.deepStrictEqual(F.matchAll(['abc'], null), []);
});

test('0002/matchAll：texts 缺失或含 null 时安全，不抛', () => {
  assert.deepStrictEqual(F.matchAll(null, 'a'), []);
  assert.deepStrictEqual(F.matchAll(undefined, 'a'), []);
  assert.deepStrictEqual(F.matchAll([null, 'a', undefined], 'a'), [{ seg: 1, start: 0, end: 1 }]);
});

test('0002/matchAll：大小写不折叠，按原样匹配', () => {
  assert.deepStrictEqual(F.matchAll(['Abc'], 'a'), []);
  assert.deepStrictEqual(F.matchAll(['Abc'], 'A'), [{ seg: 0, start: 0, end: 1 }]);
});

test('0002/matchAll：整串命中与相邻命中边界都对', () => {
  assert.deepStrictEqual(F.matchAll(['abab'], 'abab'), [{ seg: 0, start: 0, end: 4 }]);
  assert.deepStrictEqual(F.matchAll(['abab'], 'ab'), [
    { seg: 0, start: 0, end: 2 },
    { seg: 0, start: 2, end: 4 },
  ]);
});

test('0011/matchAll：命中在中文长段里的位置准确', () => {
  const text = '索引公式回滚，再索引一次';
  assert.deepStrictEqual(F.matchAll([text], '索引'), [
    { seg: 0, start: 0, end: 2 },
    { seg: 0, start: 8, end: 10 },
  ]);
  assert.strictEqual(text.slice(8, 10), '索引');
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0011（正文内查找：计数与高亮上限）
// 变体：总数永不被截断；上限只影响视觉标记。
// ─────────────────────────────────────────────────────────────────────────

test('0011/HIGHLIGHT_CAP 就是设计拍板的 2000', () => {
  assert.strictEqual(F.HIGHLIGHT_CAP, 2000);
});

test('0011/clampHits：总数永远是真的，⛔ 不因上限缩小', () => {
  const hits = new Array(40).fill({});
  assert.deepStrictEqual(F.clampHits(hits, 10), { shown: 10, total: 40, truncated: true });
});

test('0011/clampHits：没超上限时不截断', () => {
  assert.deepStrictEqual(F.clampHits(new Array(5).fill({}), 10),
    { shown: 5, total: 5, truncated: false });
  assert.deepStrictEqual(F.clampHits(new Array(10).fill({}), 10),
    { shown: 10, total: 10, truncated: false });
});

test('0011/clampHits：cap=0 时零高亮但总数照报', () => {
  assert.deepStrictEqual(F.clampHits([{}, {}], 0), { shown: 0, total: 2, truncated: true });
});

test('0011/clampHits：cap 缺失 / 负数 / 非数时回落到 2000', () => {
  const many = new Array(2500).fill({});
  assert.strictEqual(F.clampHits(many, undefined).shown, 2000);
  assert.strictEqual(F.clampHits(many, -1).shown, 2000);
  assert.strictEqual(F.clampHits(many, '10').shown, 2000);
});

test('0011/clampHits：空命中 / null 都报 0，不抛', () => {
  assert.deepStrictEqual(F.clampHits([], 10), { shown: 0, total: 0, truncated: false });
  assert.deepStrictEqual(F.clampHits(null, 10), { shown: 0, total: 0, truncated: false });
});

test('0011/capNote：没超限时不说这句话', () => {
  assert.strictEqual(F.capNote(10, 10), '');
  assert.strictEqual(F.capNote(5, 10), '');
  assert.strictEqual(F.capNote(0, 0), '');
});

test('0011/capNote：超限时两个数都在，且都是千位空格分隔', () => {
  assert.strictEqual(F.capNote(400000, 2000), '共 400 000 处，已高亮前 2 000 处');
  assert.strictEqual(F.capNote(2001, 2000), '共 2 001 处，已高亮前 2 000 处');
});

// ─────────────────────────────────────────────────────────────────────────
// 计数显示：第几 / 共几、千位空格、无结果不给数字
// ─────────────────────────────────────────────────────────────────────────

test('0011/countText：没有命中时给明确状态，⛔ 不显示 0 / 0', () => {
  assert.strictEqual(F.countText(0, 0), '无结果');
  assert.strictEqual(F.countText(-1, 0), '无结果');
  assert.strictEqual(F.countText(3, -1), '无结果');
});

test('0011/countText：命中数与当前位置从 1 起', () => {
  assert.strictEqual(F.countText(0, 3), '1 / 3');
  assert.strictEqual(F.countText(2, 3), '3 / 3');
});

test('0011/countText：四位数起用空格分千位', () => {
  assert.strictEqual(F.countText(999, 2000), '1 000 / 2 000');
  assert.strictEqual(F.countText(0, 400000), '1 / 400 000');
});

test('0011/group：只在千位处插空格，不碰负号', () => {
  assert.strictEqual(F.group(0), '0');
  assert.strictEqual(F.group(999), '999');
  assert.strictEqual(F.group(1000), '1 000');
  assert.strictEqual(F.group(1234567), '1 234 567');
  assert.strictEqual(F.group(-1000), '-1 000');
});

// ─────────────────────────────────────────────────────────────────────────
// 当前命中推进：两端环绕
// ─────────────────────────────────────────────────────────────────────────

test('0011/step：没有命中时恒为 -1', () => {
  assert.strictEqual(F.step(0, 0, 1), -1);
  assert.strictEqual(F.step(-1, 0, -1), -1);
  assert.strictEqual(F.step(3, -2, 1), -1);
});

test('0011/step：还没有当前时下键从头、上键从尾', () => {
  assert.strictEqual(F.step(-1, 5, 1), 0);
  assert.strictEqual(F.step(-1, 5, -1), 4);
  assert.strictEqual(F.step(99, 5, 1), 0);
  assert.strictEqual(F.step(99, 5, -1), 4);
});

test('0011/step：末处下键环绕回首处，首处上键环绕回末处', () => {
  assert.strictEqual(F.step(4, 5, 1), 0);
  assert.strictEqual(F.step(0, 5, -1), 4);
});

test('0011/step：中间推进与方向归一（任意非负 dir 当“下一处”）', () => {
  assert.strictEqual(F.step(1, 5, 1), 2);
  assert.strictEqual(F.step(1, 5, 7), 2);
  assert.strictEqual(F.step(1, 5, 0), 2);
  assert.strictEqual(F.step(1, 5, -1), 0);
  assert.strictEqual(F.step(1, 5, -9), 0);
});

test('0011/step：只有一处时上下键都停在 0', () => {
  assert.strictEqual(F.step(0, 1, 1), 0);
  assert.strictEqual(F.step(0, 1, -1), 0);
});

// ─────────────────────────────────────────────────────────────────────────
// 段边界判据：块级容器、排除子树、排版空白
// ─────────────────────────────────────────────────────────────────────────

test('0011/块级标签大小写不敏感，表格一族必须在内', () => {
  for (const tag of ['p', 'P', 'h1', 'H6', 'li', 'td', 'TH', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'pre', 'blockquote', 'div']) {
    assert.strictEqual(F.isBlockTag(tag), true, tag);
  }
});

test('0011/非块级与空标签不算截断点', () => {
  for (const tag of ['span', 'a', 'strong', 'em', 'code', '', null, undefined]) {
    assert.strictEqual(F.isBlockTag(tag), false, String(tag));
  }
});

test('0011/只排除公式与图自身的内容，⛔ 不排除整段', () => {
  assert.strictEqual(F.isExcludedTag('svg'), true);
  assert.strictEqual(F.isExcludedTag('SVG'), true);
  assert.strictEqual(F.isExcludedTag('math'), true);
  assert.strictEqual(F.isExcludedTag('Math'), true);
  assert.strictEqual(F.isExcludedTag('mathjax'), false);
  assert.strictEqual(F.isExcludedTag('p'), false);
  assert.strictEqual(F.isExcludedTag(null), false);
});

test('0011/排除集里只有 svg 与 math 两个，不许顺手扩大', () => {
  assert.deepStrictEqual(Array.from(F.EXCLUDED_TAGS).sort(), ['math', 'svg']);
});

test('0011/tagOf：nodeName 一律小写，空节点给空串', () => {
  assert.strictEqual(F.tagOf({ nodeName: 'DIV' }), 'div');
  assert.strictEqual(F.tagOf({ nodeName: 'Math' }), 'math');
  assert.strictEqual(F.tagOf(null), '');
  assert.strictEqual(F.tagOf({}), '');
});

test('0011/isLayoutWhitespace：全空白且不在 pre 里才算截断点', () => {
  assert.strictEqual(F.isLayoutWhitespace(' ', false), true);
  assert.strictEqual(F.isLayoutWhitespace('\n\t  ', false), true);
  assert.strictEqual(F.isLayoutWhitespace(' a ', false), false);
  assert.strictEqual(F.isLayoutWhitespace('', false), false, '零长度不是截断点');
  assert.strictEqual(F.isLayoutWhitespace('\n', true), false, 'pre 里的换行是可见内容');
});

test('0011/isLayoutWhitespace：null / undefined 当空串，零长度不切', () => {
  assert.strictEqual(F.isLayoutWhitespace(null, false), false);
  assert.strictEqual(F.isLayoutWhitespace(undefined, false), false);
});

// ─────────────────────────────────────────────────────────────────────────
// 冒烟探测：关键词一定存在、哨兵一定不存在
// ─────────────────────────────────────────────────────────────────────────

test('0011/probeQueryText：跳过开头空白，到词尾就停', () => {
  assert.strictEqual(F.probeQueryText('  hello world', 4), 'hell');
  assert.strictEqual(F.probeQueryText('\n\t中文 标题', 4), '中文');
  assert.strictEqual(F.probeQueryText('短 词', 4), '短');
});

test('0011/probeQueryText：默认取前 4 个码点，n 非法也回落 4', () => {
  assert.strictEqual(F.probeQueryText('abcdefgh'), 'abcd');
  assert.strictEqual(F.probeQueryText('abcdefgh', 0), 'abcd');
  assert.strictEqual(F.probeQueryText('abcdefgh', -3), 'abcd');
  assert.strictEqual(F.probeQueryText('abcdefgh', 2), 'ab');
});

test('0011/probeQueryText：⛔ 不从代理对中间切开（Emoji 算一个码点）', () => {
  assert.strictEqual(F.probeQueryText('😀😀😀', 1), '😀');
  assert.strictEqual(F.probeQueryText('😀😀😀', 2), '😀😀');
  assert.strictEqual(F.probeQueryText('a😀b', 2), 'a😀');
  assert.strictEqual(F.probeQueryText('a😀b', 2).length, 3, 'UTF-16 长度是 3');
});

test('0011/probeQueryText：全是空白 / 空串时返回空串，调用方要响亮处理', () => {
  assert.strictEqual(F.probeQueryText('   \n\t '), '');
  assert.strictEqual(F.probeQueryText(''), '');
  assert.strictEqual(F.probeQueryText(null), '');
});

test('0011/PROBE_SENTINEL：夹着不可见分隔符，真实语料里不会自然出现', () => {
  assert.strictEqual(F.PROBE_SENTINEL.charCodeAt(0), 0x2063);
  assert.ok(F.PROBE_SENTINEL.indexOf('rmd-find-probe') > 0);
  assert.strictEqual(F.probeQueryText(F.PROBE_SENTINEL), '⁣rmd', '默认只取前 4 个码点');
  assert.strictEqual(F.probeQueryText(F.PROBE_SENTINEL, 64), F.PROBE_SENTINEL);
  assert.deepStrictEqual(F.matchAll(['正常正文'], F.PROBE_SENTINEL), []);
});

// ─────────────────────────────────────────────────────────────────────────
// 范围提示：常驻那句话与它的字典键必须成对
// ─────────────────────────────────────────────────────────────────────────

test('0011/SCOPE_HINT 是唯一的范围说明，与字典键成对', () => {
  assert.strictEqual(F.SCOPE_HINT_KEY, 'find.scope');
  assert.strictEqual(F.SCOPE_HINT, '范围：渲染后的正文（不含 Markdown 源码标记）');
  assert.strictEqual(win.rmd.i18n.t(F.SCOPE_HINT_KEY), F.SCOPE_HINT);
});

test('0011/两档高亮注册名与样式表约定逐字一致', () => {
  assert.strictEqual(F.HL_ALL, 'rmd-find');
  assert.strictEqual(F.HL_CURRENT, 'rmd-find-current');
});
