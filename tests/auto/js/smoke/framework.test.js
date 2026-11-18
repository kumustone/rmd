// 框架冒烟：证明 `node --test` 那条路径、IIFE 加载方式与 TAP 计数都是通的。
// ⚠️ 这不是覆盖面清单；各家族的正式用例在 tests/auto/js/<family>/*.test.js。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd;
}

const RS = load('src/services/renderstat.js').renderstat;

test('代码未高亮为 0 时不显示那一句', () => {
  assert.strictEqual(RS.codeNotice({ code_highlighted: 3, code_unhighlighted: 0 }), '');
  assert.strictEqual(RS.codeNotice({}), '');
  assert.strictEqual(RS.codeNotice(null), '');
});

test('代码未高亮大于 0 时按 未高亮/总数 报出', () => {
  assert.strictEqual(
    RS.codeNotice({ code_highlighted: 7, code_unhighlighted: 2 }),
    ' · 代码未高亮 2 / 9 块（规模限制，内容完整）'
  );
});

test('代码未高亮缺分母时不印 NaN', () => {
  const s = RS.codeNotice({ code_unhighlighted: 2 });
  assert.ok(!s.includes('NaN'), s);
  assert.ok(s.includes('2 / 2'), s);
});

test('注入翻译函数时走注入的那条、且变量是 un/all', () => {
  let seen = null;
  const out = RS.codeNotice({ code_highlighted: 1, code_unhighlighted: 1 }, (key, vars) => {
    seen = { key, vars };
    return '译文';
  });
  assert.strictEqual(out, '译文');
  assert.deepStrictEqual(seen, { key: 'doc.code-unhighlighted', vars: { un: 1, all: 2 } });
});

test('图表未渲染为 0 时不显示、大于 0 时报出', () => {
  assert.strictEqual(RS.mermaidNotice({ mermaid_rendered: 2, mermaid_unrendered: 0 }), '');
  assert.strictEqual(
    RS.mermaidNotice({ mermaid_rendered: 2, mermaid_unrendered: 1 }),
    ' · 图表未渲染 1 / 3 张（原因见文内，原文完整）'
  );
});

test('两条兜底模板都只引用已提供的变量', () => {
  for (const [tpl, names] of [
    [RS.DEFAULT_TPL, ['un', 'all']],
    [RS.MERMAID_TPL, ['un', 'all']],
  ]) {
    const used = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(used)].sort(), [...names].sort(), tpl);
  }
});
