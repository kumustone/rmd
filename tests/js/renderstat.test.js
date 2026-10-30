// Q22「部分代码未高亮（规模限制）」那一句的断言（`src/services/renderstat.js`）。
//
// ⚠️ 这 7 条守的**不是"文案好不好看"**，而是两件会静默出事的事：
//    ① 该显示时不显示（判据写反 / 字段名写错 ⇒ 那句话永远不出现，屏幕上一切正常）；
//    ② 显示出来的是一句**假话**（`NaN` 块、负数块，或把"没上色"说成"内容丢了"）。
//    ⛔ ②比①更坏——用户会据此以为文档内容不完整。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// ⚠️ 这个模块是给浏览器用的经典脚本（IIFE 挂 `window.rmd`），
//    所以拿一个假的 `window` 把它跑起来——⛔ 不是 `require` 一个 CommonJS 模块。
function load() {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'src', 'services', 'renderstat.js'),
    'utf8'
  );
  const win = {};
  new Function('window', src)(win);
  return win.rmd.renderstat.codeNotice;
}

const codeNotice = load();

test('没超限时一个字都不加', () => {
  assert.strictEqual(codeNotice({ code_unhighlighted: 0, code_highlighted: 12 }), '');
  // ⚠️ 这一条是"正常文档的状态条上不该多出东西"的判据：
  //    写成 `>= 0` 或漏掉 `return ''` 都会让它红。
  assert.strictEqual(codeNotice({ code_highlighted: 12 }), '');
});

test('字段整个缺失时不显示', () => {
  assert.strictEqual(codeNotice({}), '');
  assert.strictEqual(codeNotice({ code_unhighlighted: undefined }), '');
  assert.strictEqual(codeNotice({ code_unhighlighted: null }), '');
  assert.strictEqual(codeNotice({ code_unhighlighted: NaN }), '');
  // ⚠️ 顺便钉住"没有载荷"这一支：`main.js` 那边传进来的可能是 `undefined`。
  assert.strictEqual(codeNotice(undefined), '');
  assert.strictEqual(codeNotice(null), '');
});

test('负数不显示', () => {
  // ⚠️ 判据必须是 `> 0`：写成 `!== 0` 会印出「未高亮 -1 块」——一句没人会去查的假话。
  assert.strictEqual(codeNotice({ code_unhighlighted: -1, code_highlighted: 5 }), '');
});

test('超限时同时给出分子与分母', () => {
  const s = codeNotice({ code_unhighlighted: 3, code_highlighted: 5 });
  assert.ok(s.includes('3'), s);
  assert.ok(s.includes('8'), `分母必须是 3+5=8：${s}`);
  assert.ok(s.includes('规模限制'), s);
});

test('高亮数为 0 时分母就是分子', () => {
  const s = codeNotice({ code_unhighlighted: 2, code_highlighted: 0 });
  assert.ok(s.includes('2 / 2'), s);
});

test('缺少高亮数时不许印出 NaN', () => {
  // ⭐ 这是本题真正的分岔点：`code_highlighted` 缺失而 `code_unhighlighted` 在时，
  //    朴素写法会拼出 `2 / NaN 块`。⛔ 那不是"少一点信息"，是在用户面前印一个断言失败的产物。
  const s = codeNotice({ code_unhighlighted: 2 });
  assert.ok(!s.includes('NaN'), `⛔ 状态条上出现了 NaN：${s}`);
  assert.ok(s.includes('2 / 2'), s);
});

test('文案不许把"没上色"说成"内容丢了"', () => {
  // ⚠️⚠️ 这是这一句存在的**全部意义**：Q22 的回退是"完整、转义的纯文本"，
  //     一个字节都没少。写成"被截断 / 被跳过 / 内容丢失"就是**造谣**——
  //     用户会据此以为这一块内容不可信，而去别的编辑器里重看一遍。
  const s = codeNotice({ code_unhighlighted: 1, code_highlighted: 1 });
  for (const 谎话 of ['截断', '跳过', '丢失', '省略', '不全']) {
    assert.ok(!s.includes(谎话), `⛔ 文案里出现了「${谎话}」：${s}`);
  }
  assert.ok(s.includes('完整'), `必须明说内容完整：${s}`);
});
