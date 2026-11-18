// renderstat 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：两句状态条文案的触发判据（> 0）、分母缺失时不让 NaN 见人、
// 模板与字典逐字一致、调用方注入的 tr 原样生效。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadRenderstat() {
  const win = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'src', 'services', 'renderstat.js'), 'utf8'))(win);
  return win.rmd.renderstat;
}

function loadI18n(extra) {
  const win = Object.assign({}, extra || {});
  new Function('window', fs.readFileSync(path.join(ROOT, 'src', 'services', 'i18n.js'), 'utf8'))(win);
  return win.rmd.i18n;
}

const R = loadRenderstat();

// ── 模板 ────────────────────────────────────────────────────────────

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('两句中文模板逐字锁死，占位符只有 un / all', () => {
  assert.strictEqual(R.DEFAULT_TPL, ' · 代码未高亮 {un} / {all} 块（规模限制，内容完整）');
  assert.strictEqual(R.MERMAID_TPL, ' · 图表未渲染 {un} / {all} 张（原因见文内，原文完整）');
  assert.deepStrictEqual(R.DEFAULT_TPL.match(/\{\w+\}/g), ['{un}', '{all}']);
  assert.deepStrictEqual(R.MERMAID_TPL.match(/\{\w+\}/g), ['{un}', '{all}']);
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('两句模板与 i18n 字典里的中文条目逐字相同（⛔ 不是第二份文案）', () => {
  const I = loadI18n();
  assert.strictEqual(I.DICT.zh['doc.code-unhighlighted'], R.DEFAULT_TPL);
  assert.strictEqual(I.DICT.zh['doc.diagrams-unrendered'], R.MERMAID_TPL);
});

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('Mermaid 那句不把成因说成「规模限制」，也不说内容丢了', () => {
  assert.strictEqual(R.MERMAID_TPL.indexOf('规模限制'), -1);
  assert.strictEqual(R.MERMAID_TPL.indexOf('丢失'), -1);
  assert.ok(R.MERMAID_TPL.indexOf('原文完整') >= 0);
});

// ── codeNotice：触发判据 ──────────────────────────────────────────

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('un 缺失 / 0 / 负数一律返回空串（⛔ 不拼出「未高亮 undefined」）', () => {
  assert.strictEqual(R.codeNotice(null), '');
  assert.strictEqual(R.codeNotice({}), '');
  assert.strictEqual(R.codeNotice({ code_unhighlighted: 0 }), '');
  assert.strictEqual(R.codeNotice({ code_unhighlighted: -1 }), '');
  assert.strictEqual(R.codeNotice({ code_unhighlighted: -999 }), '');
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('un 是 NaN / 非数字字符串 / Infinity 时也算没有', () => {
  assert.strictEqual(R.codeNotice({ code_unhighlighted: NaN }), '');
  assert.strictEqual(R.codeNotice({ code_unhighlighted: 'many' }), '');
  assert.strictEqual(R.codeNotice({ code_unhighlighted: Infinity }), '');
  assert.strictEqual(R.codeNotice({ code_unhighlighted: null }), '');
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('un > 0 时拼出「未高亮 un / all 块」', () => {
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: 2, code_highlighted: 3 }),
    ' · 代码未高亮 2 / 5 块（规模限制，内容完整）'
  );
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('code_highlighted 缺失时分母退成 un，⛔ 不让 NaN 见人', () => {
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: 4 }),
    ' · 代码未高亮 4 / 4 块（规模限制，内容完整）'
  );
  assert.strictEqual(R.codeNotice({ code_unhighlighted: 4 }).indexOf('NaN'), -1);
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('code_highlighted 是 Infinity / 字符串时按 0 算', () => {
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: 1, code_highlighted: Infinity }),
    ' · 代码未高亮 1 / 1 块（规模限制，内容完整）'
  );
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: 1, code_highlighted: 'x' }),
    ' · 代码未高亮 1 / 1 块（规模限制，内容完整）'
  );
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('数字字符串会被转成数值（num 不检查类型）', () => {
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: '3', code_highlighted: '7' }),
    ' · 代码未高亮 3 / 10 块（规模限制，内容完整）'
  );
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('布尔 true 被当成 1（现状如此）', () => {
  // ⚠️ 疑似缺陷：Number(true) === 1，畸形载荷会显示「未高亮 1 / 1 块」。
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: true }),
    ' · 代码未高亮 1 / 1 块（规模限制，内容完整）'
  );
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('小数不做取整，原样进文案（现状如此）', () => {
  // ⚠️ 疑似缺陷：计数出现小数说明上游口径有问题，这里却照印。
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: 2.5, code_highlighted: 1 }),
    ' · 代码未高亮 2.5 / 3.5 块（规模限制，内容完整）'
  );
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('code_highlighted 为负时分母可能小于 un（现状如此）', () => {
  // ⚠️ 疑似缺陷：all = -3 + 2 = -1，屏幕上会出现「2 / -1 块」。
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: 2, code_highlighted: -3 }),
    ' · 代码未高亮 2 / -1 块（规模限制，内容完整）'
  );
});

// ── codeNotice：注入 tr ───────────────────────────────────────────

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('注入 tr 时用它翻译，并把 un / all 作为 vars 传过去', () => {
  const seen = [];
  const tr = function (k, vars) { seen.push([k, vars]); return 'T'; };
  assert.strictEqual(R.codeNotice({ code_unhighlighted: 2, code_highlighted: 3 }, tr), 'T');
  assert.deepStrictEqual(seen, [['doc.code-unhighlighted', { un: 2, all: 5 }]]);
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('不显示时根本不调 tr', () => {
  let calls = 0;
  R.codeNotice({ code_unhighlighted: 0 }, function () { calls += 1; return 'x'; });
  R.codeNotice({}, function () { calls += 1; return 'x'; });
  assert.strictEqual(calls, 0);
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('非函数的 tr 退回中文模板', () => {
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: 1 }, 'nope'),
    ' · 代码未高亮 1 / 1 块（规模限制，内容完整）'
  );
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('用真 i18n 的 t 渲染，中英各自成形', () => {
  const I = loadI18n();
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: 2, code_highlighted: 3 }, I.t),
    ' · 代码未高亮 2 / 5 块（规模限制，内容完整）'
  );
  I.setLang('en');
  assert.strictEqual(
    R.codeNotice({ code_unhighlighted: 2, code_highlighted: 3 }, I.t),
    ' · 2 / 5 code blocks not highlighted (size limit; content is complete)'
  );
});

// ── mermaidNotice ────────────────────────────────────────────────

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('mermaid un 缺失 / 0 / 负数 / NaN 一律空串', () => {
  assert.strictEqual(R.mermaidNotice(null), '');
  assert.strictEqual(R.mermaidNotice({}), '');
  assert.strictEqual(R.mermaidNotice({ mermaid_unrendered: 0 }), '');
  assert.strictEqual(R.mermaidNotice({ mermaid_unrendered: -2 }), '');
  assert.strictEqual(R.mermaidNotice({ mermaid_unrendered: NaN }), '');
});

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('mermaid un > 0 时拼出「未渲染 un / all 张」，分母含已渲染数', () => {
  assert.strictEqual(
    R.mermaidNotice({ mermaid_unrendered: 1, mermaid_rendered: 3 }),
    ' · 图表未渲染 1 / 4 张（原因见文内，原文完整）'
  );
});

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('mermaid_rendered 缺失时分母退成 un', () => {
  assert.strictEqual(
    R.mermaidNotice({ mermaid_unrendered: 2 }),
    ' · 图表未渲染 2 / 2 张（原因见文内，原文完整）'
  );
  assert.strictEqual(R.mermaidNotice({ mermaid_unrendered: 2 }).indexOf('NaN'), -1);
});

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('mermaid 用注入的 tr 与专属字典键', () => {
  const seen = [];
  const tr = function (k, vars) { seen.push([k, vars]); return 'M'; };
  assert.strictEqual(R.mermaidNotice({ mermaid_unrendered: 5, mermaid_rendered: 1 }, tr), 'M');
  assert.deepStrictEqual(seen, [['doc.diagrams-unrendered', { un: 5, all: 6 }]]);
});

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('mermaid 用真 i18n 的 t 渲染，中文与模板逐字一致', () => {
  const I = loadI18n();
  assert.strictEqual(
    R.mermaidNotice({ mermaid_unrendered: 1, mermaid_rendered: 3 }, I.t),
    R.MERMAID_TPL.replace('{un}', '1').replace('{all}', '4')
  );
});

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('mermaid 与 code 两条互不串键：只有代码未高亮时图表那句为空', () => {
  const s = { code_unhighlighted: 2, code_highlighted: 1 };
  assert.notStrictEqual(R.codeNotice(s), '');
  assert.strictEqual(R.mermaidNotice(s), '');
  const t = { mermaid_unrendered: 2, mermaid_rendered: 1 };
  assert.notStrictEqual(R.mermaidNotice(t), '');
  assert.strictEqual(R.codeNotice(t), '');
});

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('mermaid_rendered 为负会算出小于 un 的分母（现状如此）', () => {
  // ⚠️ 疑似缺陷：与 codeNotice 同族，all = -1 + 2 = 1，屏幕上是「2 / 1 张」。
  assert.strictEqual(
    R.mermaidNotice({ mermaid_unrendered: 2, mermaid_rendered: -1 }),
    ' · 图表未渲染 2 / 1 张（原因见文内，原文完整）'
  );
});

// ── 两句的公共性质 ────────────────────────────────────────────────

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('无论输入多畸形，输出要么是空串、要么不含 NaN / undefined / null', () => {
  const inputs = [
    null, undefined, {}, { code_unhighlighted: NaN }, { code_unhighlighted: 'x' },
    { code_unhighlighted: 1, code_highlighted: NaN },
    { code_unhighlighted: 1, code_highlighted: 'y' },
  ];
  for (const s of inputs) {
    const out = R.codeNotice(s);
    assert.strictEqual(out.indexOf('NaN'), -1, JSON.stringify(s));
    assert.strictEqual(out.indexOf('undefined'), -1, JSON.stringify(s));
    assert.strictEqual(out.indexOf('null'), -1, JSON.stringify(s));
  }
});

// 源自 docs/bugs/0075（超长图类型把回退提示撑到-900-字节）
test('两句都以空格点开头，便于直接追加到状态条', () => {
  assert.ok(R.codeNotice({ code_unhighlighted: 1 }).indexOf(' · ') === 0);
  assert.ok(R.mermaidNotice({ mermaid_unrendered: 1 }).indexOf(' · ') === 0);
});
