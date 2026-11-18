// renderstat / renderbudget 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：两处状态条提示的判据与文案——「代码未高亮」「图表未渲染」只在
// 计数 > 0 时说话、分母缺失时退成已计数、⛔ 不印 NaN；提交重渲的慢阈值只在
// 重渲那一路生效，且毫秒先四舍五入再比阈值。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load(rel) {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', src)(win);
  return win.rmd;
}

const stat = load('src/services/renderstat.js').renderstat;
const budget = load('src/services/renderbudget.js').renderbudget;

// ── renderstat.codeNotice ────────────────────────────────────────

test('renderstat：中文兜底模板逐字固定', () => {
  assert.strictEqual(
    stat.DEFAULT_TPL,
    ' · 代码未高亮 {un} / {all} 块（规模限制，内容完整）'
  );
  assert.strictEqual(
    stat.MERMAID_TPL,
    ' · 图表未渲染 {un} / {all} 张（原因见文内，原文完整）'
  );
});

test('codeNotice：未高亮数为 0 / 缺失 / 负数 / 非数时一律不说话', () => {
  assert.strictEqual(stat.codeNotice(null), '');
  assert.strictEqual(stat.codeNotice({}), '');
  assert.strictEqual(stat.codeNotice({ code_unhighlighted: 0 }), '');
  assert.strictEqual(stat.codeNotice({ code_unhighlighted: -3 }), '');
  assert.strictEqual(stat.codeNotice({ code_unhighlighted: NaN }), '');
  assert.strictEqual(stat.codeNotice({ code_unhighlighted: 'abc' }), '');
});

test('codeNotice：有未高亮块时给出 un / all 与兜底文案', () => {
  assert.strictEqual(
    stat.codeNotice({ code_unhighlighted: 2, code_highlighted: 5 }),
    ' · 代码未高亮 2 / 7 块（规模限制，内容完整）'
  );
});

test('codeNotice：已高亮字段缺失时分母退成未高亮数，⛔ 不印 NaN', () => {
  const s = stat.codeNotice({ code_unhighlighted: 2 });
  assert.strictEqual(s, ' · 代码未高亮 2 / 2 块（规模限制，内容完整）');
  assert.ok(s.indexOf('NaN') < 0);
});

test('codeNotice：数字字符串按数字处理（后端可能送字符串）', () => {
  assert.strictEqual(
    stat.codeNotice({ code_unhighlighted: '2', code_highlighted: '3' }),
    ' · 代码未高亮 2 / 5 块（规模限制，内容完整）'
  );
});

test('codeNotice：注入翻译函数时用 status 键与 {un, all} 变量', () => {
  const seen = [];
  const text = stat.codeNotice({ code_unhighlighted: 1, code_highlighted: 9 }, function (k, vars) {
    seen.push([k, vars]);
    return 'T:' + vars.un + '/' + vars.all;
  });
  assert.strictEqual(text, 'T:1/10');
  assert.deepStrictEqual(seen, [['doc.code-unhighlighted', { un: 1, all: 10 }]]);
});

test('codeNotice：不该说话时绝不调用翻译函数', () => {
  let calls = 0;
  stat.codeNotice({ code_unhighlighted: 0 }, function () { calls += 1; return 'x'; });
  assert.strictEqual(calls, 0);
});

// ── renderstat.mermaidNotice ─────────────────────────────────────

test('mermaidNotice：未渲染数为 0 / 缺失 / 负数 / 非数时一律不说话', () => {
  assert.strictEqual(stat.mermaidNotice(null), '');
  assert.strictEqual(stat.mermaidNotice({}), '');
  assert.strictEqual(stat.mermaidNotice({ mermaid_unrendered: 0 }), '');
  assert.strictEqual(stat.mermaidNotice({ mermaid_unrendered: -1 }), '');
  assert.strictEqual(stat.mermaidNotice({ mermaid_unrendered: 'x' }), '');
});

test('mermaidNotice：给出未渲染 / 总数与兜底文案', () => {
  assert.strictEqual(
    stat.mermaidNotice({ mermaid_unrendered: 2, mermaid_rendered: 3 }),
    ' · 图表未渲染 2 / 5 张（原因见文内，原文完整）'
  );
  assert.strictEqual(
    stat.mermaidNotice({ mermaid_unrendered: 4 }),
    ' · 图表未渲染 4 / 4 张（原因见文内，原文完整）'
  );
});

test('mermaidNotice：注入翻译函数时用 doc.diagrams-unrendered 键', () => {
  const seen = [];
  const text = stat.mermaidNotice({ mermaid_unrendered: 2, mermaid_rendered: 3 }, function (k, vars) {
    seen.push([k, vars]);
    return 'T:' + vars.all;
  });
  assert.strictEqual(text, 'T:5');
  assert.deepStrictEqual(seen, [['doc.diagrams-unrendered', { un: 2, all: 5 }]]);
});

// ── renderbudget.judge ───────────────────────────────────────────

test('renderbudget：慢阈值 300 ms，兜底模板逐字固定', () => {
  assert.strictEqual(budget.SLOW_MS, 300);
  assert.strictEqual(budget.DEFAULT_TPL, ' · 本次重渲整篇 {ms} ms（文档越大越慢）');
});

test('costOf：t5 与 t5b 相加；缺失 / 负数 / 非有限值按 0', () => {
  assert.strictEqual(budget.judge({ t5_ms: 100, t5b_ms: 50, rerender: true }).ms, 150);
  assert.strictEqual(budget.judge({ t5_ms: -100, t5b_ms: -50, rerender: true }).ms, 0);
  assert.strictEqual(budget.judge({ t5_ms: Infinity, t5b_ms: 20, rerender: true }).ms, 20);
  assert.strictEqual(budget.judge({ t5_ms: '100', t5b_ms: '50', rerender: true }).ms, 150);
  assert.strictEqual(budget.judge({}, true).ms, 0);
});

test('judge：打开文档那一次（非重渲）即使很慢也不说话', () => {
  const r = budget.judge({ t5_ms: 4000, t5b_ms: 1000, rerender: false });
  assert.deepStrictEqual(r, { slow: false, ms: 5000, kb: 0, text: '' });
  assert.strictEqual(budget.notice({ t5_ms: 4000, t5b_ms: 1000 }), '');
});

test('judge：先四舍五入毫秒再比阈值——299.6 算 300，慢', () => {
  assert.strictEqual(budget.judge({ t5_ms: 299.6, rerender: true }).slow, true);
  assert.strictEqual(budget.judge({ t5_ms: 299.4, rerender: true }).slow, false);
  assert.strictEqual(budget.judge({ t5_ms: 299.4, rerender: true }).ms, 299);
});

test('judge：正好 300 ms 触发，299 ms 不触发', () => {
  assert.strictEqual(budget.judge({ t5_ms: 300, rerender: true }).slow, true);
  assert.strictEqual(budget.judge({ t5_ms: 299, rerender: true }).slow, false);
});

test('judge：触发时给默认中文文案与毫秒数', () => {
  const r = budget.judge({ t5_ms: 400, rerender: true });
  assert.strictEqual(r.slow, true);
  assert.strictEqual(r.ms, 400);
  assert.strictEqual(r.text, ' · 本次重渲整篇 400 ms（文档越大越慢）');
});

test('judge：kb 按 1024 四舍五入，缺失 / 非正 / 非数按 0', () => {
  assert.strictEqual(budget.judge({ t5_ms: 300, rerender: true, html_bytes: 2048 }).kb, 2);
  assert.strictEqual(budget.judge({ t5_ms: 300, rerender: true, html_bytes: 1023 }).kb, 1);
  assert.strictEqual(budget.judge({ t5_ms: 300, rerender: true, html_bytes: 0 }).kb, 0);
  assert.strictEqual(budget.judge({ t5_ms: 300, rerender: true, html_bytes: -1 }).kb, 0);
  assert.strictEqual(budget.judge({ t5_ms: 300, rerender: true, html_bytes: 'abc' }).kb, 0);
});

test('judge：注入翻译函数时用 status.commit-slow 与 {ms, kb}', () => {
  const seen = [];
  const r = budget.judge({ t5_ms: 350, rerender: true, html_bytes: 4096 }, function (k, vars) {
    seen.push([k, vars]);
    return 'T:' + vars.ms + '/' + vars.kb;
  });
  assert.strictEqual(r.text, 'T:350/4');
  assert.deepStrictEqual(seen, [['status.commit-slow', { ms: 350, kb: 4 }]]);
});

test('judge：不触发时 text 是空串而不是 undefined', () => {
  const r = budget.judge({ t5_ms: 10, rerender: true });
  assert.strictEqual(r.text, '');
  assert.strictEqual(typeof r.text, 'string');
});

test('notice：只取那句话，不触发时为空串', () => {
  assert.strictEqual(
    budget.notice({ t5_ms: 500, t5b_ms: 100, rerender: true }),
    ' · 本次重渲整篇 600 ms（文档越大越慢）'
  );
  assert.strictEqual(budget.notice({ t5_ms: 500, rerender: false }), '');
  assert.strictEqual(budget.notice(null), '');
});
