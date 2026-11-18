// 正文内查找的纯逻辑（`src/services/find.js`）的补充用例。
//
// 这里守的是“段边界”与“计数诚实”：段判据写错会框出屏幕上有、但源里不在的文本，
// 而上限写错会让用户看到的总数被悄悄截断——两者都不会报错。
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
// 标签判据
// ─────────────────────────────────────────────────────────────────────────

test('tagOf：取 nodeName 并转小写，缺件不抛', () => {
  assert.strictEqual(F.tagOf({ nodeName: 'P' }), 'p');
  assert.strictEqual(F.tagOf({ nodeName: 'TD' }), 'td');
  assert.strictEqual(F.tagOf(null), '');
  assert.strictEqual(F.tagOf({}), '');
  assert.strictEqual(F.tagOf({ nodeName: 7 }), '7');
});

test('isBlockTag：白名单大小写不敏感，行内元素不在其中', () => {
  assert.strictEqual(F.isBlockTag('DIV'), true);
  assert.strictEqual(F.isBlockTag('table'), true);
  assert.strictEqual(F.isBlockTag('td'), true);
  assert.strictEqual(F.isBlockTag('span'), false);
  assert.strictEqual(F.isBlockTag('a'), false);
  assert.strictEqual(F.isBlockTag(null), false);
});

test('isExcludedTag：只有 svg 与 math 两个根，大小写不敏感', () => {
  assert.strictEqual(F.isExcludedTag('svg'), true);
  assert.strictEqual(F.isExcludedTag('MATH'), true);
  assert.strictEqual(F.isExcludedTag('p'), false);
  assert.strictEqual(F.isExcludedTag(''), false);
});

test('块级白名单覆盖表格一族（每个单元格各自成段）', () => {
  for (const tag of ['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']) {
    assert.strictEqual(F.isBlockTag(tag), true, tag);
  }
  assert.strictEqual(F.BLOCK_TAGS.has('br'), false, 'br 是单独一类截断点，不在块级白名单里');
});

// ─────────────────────────────────────────────────────────────────────────
// 排版空白与关键词归一
// ─────────────────────────────────────────────────────────────────────────

test('isLayoutWhitespace：全空白且不在 pre 里才算', () => {
  assert.strictEqual(F.isLayoutWhitespace(' ', false), true);
  assert.strictEqual(F.isLayoutWhitespace('\n\t ', false), true);
  assert.strictEqual(F.isLayoutWhitespace('a', false), false);
  assert.strictEqual(F.isLayoutWhitespace(' a ', false), false);
  assert.strictEqual(F.isLayoutWhitespace(' ', true), false, '<pre> 里的空白是可见内容');
});

test('isLayoutWhitespace：长度 0 的节点不算截断点', () => {
  assert.strictEqual(F.isLayoutWhitespace('', false), false);
  assert.strictEqual(F.isLayoutWhitespace(null, false), false);
  assert.strictEqual(F.isLayoutWhitespace(7, false), false);
});

test('normalizeQuery：只有空白等于没输入，非空白原样保留', () => {
  assert.strictEqual(F.normalizeQuery(null), '');
  assert.strictEqual(F.normalizeQuery(undefined), '');
  assert.strictEqual(F.normalizeQuery(''), '');
  assert.strictEqual(F.normalizeQuery('   '), '');
  assert.strictEqual(F.normalizeQuery(' a '), ' a ', '⛔ 不顺手 trim 掉用户输入的空格');
});

// ─────────────────────────────────────────────────────────────────────────
// 匹配
// ─────────────────────────────────────────────────────────────────────────

test('matchAll：非重叠匹配（aaaa 里搜 aa 是 2 处）', () => {
  assert.deepStrictEqual(F.matchAll(['aaaa'], 'aa'), [
    { seg: 0, start: 0, end: 2 }, { seg: 0, start: 2, end: 4 },
  ]);
});

test('matchAll：跨段走，段序与段内先后都对', () => {
  assert.deepStrictEqual(F.matchAll(['abab', 'xxa'], 'a'), [
    { seg: 0, start: 0, end: 1 },
    { seg: 0, start: 2, end: 3 },
    { seg: 1, start: 2, end: 3 },
  ]);
});

test('matchAll：大小写敏感（与源域搜索同口径）', () => {
  assert.deepStrictEqual(F.matchAll(['Ab'], 'ab'), []);
  assert.deepStrictEqual(F.matchAll(['Ab'], 'Ab'), [{ seg: 0, start: 0, end: 2 }]);
});

test('matchAll：空关键词 / 空数组 / 空段都给空结果', () => {
  assert.deepStrictEqual(F.matchAll(['abc'], ''), []);
  assert.deepStrictEqual(F.matchAll(['abc'], '   '), []);
  assert.deepStrictEqual(F.matchAll([], 'a'), []);
  assert.deepStrictEqual(F.matchAll([''], 'a'), []);
});

test('matchAll：非数组 texts 与 null 段不抛', () => {
  assert.deepStrictEqual(F.matchAll(null, 'a'), []);
  assert.deepStrictEqual(F.matchAll([null, undefined], ''), []);
});

// ─────────────────────────────────────────────────────────────────────────
// 上限、推进、文案
// ─────────────────────────────────────────────────────────────────────────

test('clampHits：只截视觉标记，总数永远如实报告', () => {
  const hits = new Array(2500).fill(0);
  assert.deepStrictEqual(F.clampHits(hits), { shown: 2000, total: 2500, truncated: true });
  assert.deepStrictEqual(F.clampHits(hits, 10), { shown: 10, total: 2500, truncated: true });
});

test('clampHits：没有超限时 truncated 为假（含空结果）', () => {
  assert.deepStrictEqual(F.clampHits([1, 2, 3]), {
    shown: 3, total: 3, truncated: false,
  });
  assert.deepStrictEqual(F.clampHits(null), { shown: 0, total: 0, truncated: false });
});

test('clampHits：cap 为 0 合法，负数 / 非数回落到默认上限', () => {
  const hits = new Array(2001).fill(0);
  assert.deepStrictEqual(F.clampHits(hits, 0), { shown: 0, total: 2001, truncated: true });
  assert.deepStrictEqual(F.clampHits(hits, -1), { shown: 2000, total: 2001, truncated: true });
  assert.deepStrictEqual(F.clampHits(hits, 'x'), { shown: 2000, total: 2001, truncated: true });
});

test('step：没有结果时恒为 -1', () => {
  assert.strictEqual(F.step(0, 0, 1), -1);
  assert.strictEqual(F.step(-1, -3, 1), -1);
  assert.strictEqual(F.step(5, 0, -1), -1);
});

test('step：没有当前时，向下从第一条、向上从最后一条', () => {
  assert.strictEqual(F.step(-1, 5, 1), 0);
  assert.strictEqual(F.step(-1, 5, -1), 4);
});

test('step：两端环绕', () => {
  assert.strictEqual(F.step(4, 5, 1), 0);
  assert.strictEqual(F.step(0, 5, -1), 4);
  assert.strictEqual(F.step(2, 5, 1), 3);
  assert.strictEqual(F.step(2, 5, -1), 1);
});

test('step：越界的当前下标按“没有选中”处理', () => {
  assert.strictEqual(F.step(5, 5, 1), 0);
  assert.strictEqual(F.step(99, 5, -1), 4);
});

test('step：dir 为 0 或负数时按“下一个 / 上一个”归一', () => {
  assert.strictEqual(F.step(1, 5, 0), 2, 'dir=0 被当成 +1');
  assert.strictEqual(F.step(1, 5, -7), 0);
  assert.strictEqual(F.step(1, 5, 7), 2);
});

test('group：千位用空格分隔（不用逗号）', () => {
  assert.strictEqual(F.group(0), '0');
  assert.strictEqual(F.group(999), '999');
  assert.strictEqual(F.group(1000), '1 000');
  assert.strictEqual(F.group(1234567), '1 234 567');
});

test('countText：无结果时不给数字，有结果时是 第几 / 共几', () => {
  assert.strictEqual(F.countText(0, 0), '无结果');
  assert.strictEqual(F.countText(-1, -1), '无结果');
  assert.strictEqual(F.countText(0, 1), '1 / 1');
  assert.strictEqual(F.countText(1999, 12345), '2 000 / 12 345');
});

test('capNote：没超限不说，超限时两个数都要在', () => {
  assert.strictEqual(F.capNote(3, 3), '');
  assert.strictEqual(F.capNote(2, 3), '');
  assert.strictEqual(F.capNote(2500, 2000), '共 2 500 处，已高亮前 2 000 处');
});

// ─────────────────────────────────────────────────────────────────────────
// 探测词与常量
// ─────────────────────────────────────────────────────────────────────────

test('probeQueryText：跳过前导空白，取前 n 个码点', () => {
  assert.strictEqual(F.probeQueryText('   hello world'), 'hell');
  assert.strictEqual(F.probeQueryText('hello world', 2), 'he');
  assert.strictEqual(F.probeQueryText('hello world', 99), 'hello');
});

test('probeQueryText：不切碎代理对，也不跨空白', () => {
  assert.strictEqual(F.probeQueryText('😀abc', 1), '😀');
  assert.strictEqual(F.probeQueryText('😀abc', 3), '😀ab');
  assert.strictEqual(F.probeQueryText('甲 乙', 99), '甲');
});

test('probeQueryText：全空白 / 非字符串 / 非法 n 的兜底', () => {
  assert.strictEqual(F.probeQueryText('   '), '');
  assert.strictEqual(F.probeQueryText(null), '');
  assert.strictEqual(F.probeQueryText('abcdef', 0), 'abcd', '非法 n 回到默认 4');
  assert.strictEqual(F.probeQueryText('abcdef', -1), 'abcd');
});

test('常量：高亮上限 2000、两档注册名、哨兵词', () => {
  assert.strictEqual(F.HIGHLIGHT_CAP, 2000);
  assert.strictEqual(F.HL_ALL, 'rmd-find');
  assert.strictEqual(F.HL_CURRENT, 'rmd-find-current');
  assert.ok(F.PROBE_SENTINEL.includes('rmd-find-probe'));
});

test('范围提示的中文原文与字典里的 find.scope 逐字相同', () => {
  assert.strictEqual(F.SCOPE_HINT_KEY, 'find.scope');
  assert.strictEqual(win.rmd.i18n.t(F.SCOPE_HINT_KEY), F.SCOPE_HINT);
  assert.strictEqual(F.SCOPE_HINT, '范围：渲染后的正文（不含 Markdown 源码标记）');
});
