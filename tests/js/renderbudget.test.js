// 「本次重渲整篇 N ms」那一句的断言（`src/services/renderbudget.js`，
// 2026-10-29 代码评审第 5 条）。
//
// ⚠️ 这一格的失效形态**全部是静默的**——所以判据必须在这里，⛔ 不能内联在 `main.js`
//    （后者不进 `tests/js/`，写在那儿的判据测试碰不到）：
//    ① 阈值写反（`>` 而不是 `>=`、或者把 `rerender` 判丢）⇒ 那句话**永远不出现**，
//       屏幕上一切正常，而它存在的全部意义就是"大文档里编辑会卡"这件事被说出来；
//    ② 反过来，没重渲也说 ⇒ 打开一份大文档时就冒出一句"本次重渲"，用户会以为
//       **是他刚才的操作**引起的；
//    ③ 缺字段时印出 `NaN` / `undefined` ⇒ 状态条上一条没人会去查的假话。
//
// ⭐ 另有三条**源码级**判据（第 ⑧ 条）：这一条修法的核心不是 `judge()` 本身，
// 而是"生产路径上**有没有计时**"——`measure` 只在 `RMD_MEASURE=1` 时存在，
// 原来 `t5_ms`/`t5b_ms` 在生产上**恒为 0**，那句话的输入永远是 0 = 整个功能不存在。
// 那一态**用公开 API 构造不出来**（`judge({t5_ms:0})` 本来就该不说话），
// 只能读源码。同族先例：`chrome.test.js` / `live-wiring.test.js`。
//
// 跑法：`make test-js`。⚠️ 放在仓库根的 `tests/js/` 而不是 `src/`：
//       `src/` 是 Tauri 的 `frontendDist`，整个目录**会在编译期嵌进二进制**。
//
// ── 变异台账（2026-10-29，每处都先证明"改到了"：命中恰 1、cksum 前后不同）──
//   M1 `judge` 的 `rerender &&` 去掉        ⇒ 只红第 1 条（"打开那一次不说话"）
//   M2 `ms >= SLOW_MS` → `ms > SLOW_MS`     ⇒ 红第 3、4 条（边界样点分得开）
//   M3 `main.js` 的 `rerender: !!o.keepScroll` → `true`
//                                           ⇒ 只红第 ⑧ 条
//   M4 `span` 兜底返回 `ms: 0` 而不是 `performance.now() - a`
//                                           ⇒ 只红第 ⑧ 条。⚠️ **第一次跑它没红**——
//      判据当时写的是"这段里出现过 `performance.now()`"，而残留的 `const a =` 让它恒真
//      （`tests.md` 说的"判据不敏感"那一档）⇒ 已改成钉**返回值那一行**。
//   M5 `DEFAULT_TPL` 与 zh 字典不再逐字相同 ⇒ 只红第 7 条
//   负对照：以上每次还原后 `make test-js` 全绿（第 ⑧ 条依赖另外三处，
//   摘掉任一处的接线而**不动**它判的那一行时不该红）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../src');

/** ⚠️ 经典脚本（IIFE 挂 `window.rmd`）⇒ 拿一个假 `window` 把它跑起来。 */
function load() {
  const src = fs.readFileSync(path.join(SRC, 'services', 'renderbudget.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd.renderbudget;
}

const RB = load();
const I = require('../../src/services/i18n.js');

/** 一次"刚提交完、花了 ms 毫秒"的重渲。 */
function commit(ms, extra) {
  const t = Object.assign({ t5_ms: ms, t5b_ms: 0, html_bytes: 200 * 1024, rerender: true }, extra);
  return RB.judge(t, I.t);
}

// ────────────────────────────────────────────────────────────────
// 该不该说
// ────────────────────────────────────────────────────────────────

test('打开文档那一次一个字都不加（哪怕花了 5 秒）', () => {
  // ⚠️ 这是**最容易写错**的一支：`judge` 一旦漏掉 `rerender` 判据，
  //    打开一份 10 MB 文档就会冒出一句"本次重渲整篇 3745 ms"——而用户此刻**还没编辑**，
  //    他会以为是打开慢，其实打开那一次已经有 T1/T2/T3 在说了。
  const r = RB.judge({ t5_ms: 5000, t5b_ms: 0, html_bytes: 1e6, rerender: false }, I.t);
  assert.strictEqual(r.slow, false);
  assert.strictEqual(r.text, '');
  // ⚠️ `rerender` **缺失**也必须按"不说"处理（不是按真值取反）：
  //    调用点漏传时，宁可不说话也不要在一份正常文档上说假话。
  assert.strictEqual(RB.notice({ t5_ms: 5000, t5b_ms: 0 }, I.t), '');
  assert.strictEqual(RB.notice({ t5_ms: 5000, t5b_ms: 0, rerender: undefined }, I.t), '');
});

test('没到阈值不说话', () => {
  assert.strictEqual(commit(RB.SLOW_MS - 1).text, '');
  assert.strictEqual(commit(0).text, '');
});

test('到阈值就说（边界取 >=）', () => {
  // ⚠️ 边界语义是**规格的一部分**：`>=` 与 `>` 在这一个样点上分得开，
  //    写成 `>` 之后"刚好 300 ms"不说、301 ms 才说，而这中间没有任何人会察觉，
  //    直到某份文档稳定停在 300 ms 上。⇒ 判据必须钉住这一个样点。
  const r = commit(RB.SLOW_MS);
  assert.strictEqual(r.slow, true);
  assert.strictEqual(r.ms, RB.SLOW_MS);
  assert.ok(r.text.includes(String(RB.SLOW_MS)), r.text);
});

test('t5 与 t5b 是**加起来**的（强制布局那半也算整篇成本）', () => {
  // ⚠️ 只算 `t5` 会**系统性低估**：`t5b`（`offsetHeight` 那一次强制布局）在 XL 语料上
  //    是同一量级的一笔。实测 401 / 1245 / 2660 / 3745 ms 这两个数都含在内。
  const half = RB.SLOW_MS / 2;
  const r = RB.judge({ t5_ms: half, t5b_ms: half, rerender: true }, I.t);
  assert.strictEqual(r.ms, RB.SLOW_MS);
  assert.strictEqual(r.slow, true);
  // 负对照：任何**一半**单独拿出来都不够。
  assert.strictEqual(commit(half).text, '');
});

test('缺字段 / 非有限值 / 负数一律当 0（⛔ 不许印 NaN）', () => {
  const bad = [
    {},
    { t5_ms: undefined, t5b_ms: undefined },
    { t5_ms: null, t5b_ms: null },
    { t5_ms: NaN, t5b_ms: NaN },
    { t5_ms: Infinity, t5b_ms: -1 },
    { t5_ms: 'abc', t5b_ms: {} },
  ];
  for (const b of bad) {
    const r = RB.judge(Object.assign({ rerender: true }, b), I.t);
    assert.strictEqual(r.ms, 0, JSON.stringify(b));
    assert.strictEqual(r.text, '', JSON.stringify(b));
    assert.ok(!String(r.text).includes('NaN'), `⛔ 出现了 NaN：${r.text}`);
  }
});

test('不该说话时 `notice()` 是空串（⛔ 不是 undefined）', () => {
  // ⚠️ 状态条是**字符串拼接**：`undefined` 会原样印在屏幕上（`… 图片 3/3）undefined`）。
  assert.strictEqual(RB.notice({ rerender: false }, I.t), '');
  assert.strictEqual(RB.notice(undefined, I.t), '');
  assert.strictEqual(RB.notice(null, I.t), '');
});

// ────────────────────────────────────────────────────────────────
// 说什么
// ────────────────────────────────────────────────────────────────

test('文案走字典，且与 `DEFAULT_TPL` 逐字相同', () => {
  // ⚠️ `DEFAULT_TPL` 是**没有 `tr` 时**的兜底（`judge` 在 Node 里也要能单独用），
  //    它与 zh 字典必须是同一句话——否则两个入口说出两种话，而且**谁也不会报错**。
  //    同族判据：`renderstat.js` 的 `doc.code-unhighlighted` 那条注释。
  const zh = I.t('status.commit-slow', { ms: 42 });
  const fallback = RB.DEFAULT_TPL.replace(/\{ms\}/g, '42').replace(/\{kb\}/g, '200');
  assert.strictEqual(zh, fallback);
  // ⭐ 两句都必须在字典里（`en` 少一条会**静默**回落中文，见 `i18n.test.js` 头注释）。
  assert.ok(I.has('status.commit-slow', 'zh'));
  assert.ok(I.has('status.commit-slow', 'en'));
});

test('没有 `tr` 时用兜底模板，占位符不许漏成空', () => {
  const r = commit(RB.SLOW_MS);
  assert.ok(/^\s·\s本次重渲整篇 300 ms/.test(r.text), r.text);
  assert.ok(!r.text.includes('{ms}'), `⛔ 占位符没被替换：${r.text}`);
  assert.ok(!r.text.includes('{kb}'), `⛔ 占位符没被替换：${r.text}`);
  // ⚠️ 文案要说"整篇"：让用户知道慢的是**这一次全文重渲**，⛔ 不是他改的那一块
  //    （否则会以为自己那一小段有问题）。措辞本身是产品口径，钉住它。
  assert.ok(r.text.includes('整篇'), r.text);
});

test('`kb` 有值就带上、没有就不印 0 KB 之外的假话', () => {
  assert.strictEqual(commit(RB.SLOW_MS).kb, 200);
  assert.strictEqual(commit(RB.SLOW_MS, { html_bytes: 0 }).kb, 0);
  assert.strictEqual(commit(RB.SLOW_MS, { html_bytes: undefined }).kb, 0);
  assert.strictEqual(commit(RB.SLOW_MS, { html_bytes: NaN }).kb, 0);
});

// ────────────────────────────────────────────────────────────────
// ⑧ 源码级：生产路径上到底有没有计时
// ────────────────────────────────────────────────────────────────

test('接线：`main.js` 喂的是**这一次挂载的真实耗时**，且只在重渲时说话', () => {
  // ⭐ 这一条是本题的**核心回归**：`mountDocument` 原来只在 `measure` 存在时计时，
  //    而 `measure` 只在 `RMD_MEASURE=1` 时创建 ⇒ 生产上 `t5_ms`/`t5b_ms` 恒 0，
  //    于是"超过 300 ms 就说"这句话**永远不会出现**，而屏幕上一切正常。
  //    ⚠️ 这一态**构造不出来**（`judge({t5_ms:0})` 本来就该不说话）⇒ 只能读源码。
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');

  // ① `innerHTML` 那一段必须包在计时器里（不论是 `measure.span` 还是 `performance.now()`）。
  const spanDecl = main.indexOf('const span = function (fn) {');
  assert.ok(spanDecl > 0, '⛔ 找不到 `mountDocument` 里的 `span` 计时器');
  const spanBody = main.slice(spanDecl, spanDecl + 400);
  assert.ok(spanBody.includes('measure.span(fn)'), '⛔ 有测量器时没走 `measure.span`');
  // ⚠️ 判据必须是"**返回的 ms 由 `performance.now()` 算出来**"，⛔ 不是"这段里出现过
  //    `performance.now()`"——后者在把返回值改成 `ms: 0` 之后**照样成立**（残留的 `const a =`），
  //    实测变异 M4 就这么漏过去过一次。
  assert.ok(
    /return \{\s*ms:\s*performance\.now\(\)\s*-\s*a/.test(spanBody),
    '⛔ 没有测量器时必须真的用 `performance.now()` 计时（⛔ 不是恒 0）'
  );
  assert.ok(
    main.includes('let t5 = span(function () { doc.innerHTML = payload.html; });'),
    '⛔ `innerHTML` 那一段没被计时'
  );
  assert.ok(
    main.includes('t5b = span(function () { return doc.offsetHeight; });'),
    '⛔ 强制布局那一段没被计时'
  );
  // ② 强制布局**不许**在打开文档那条路上无条件新增一次（今天那条路是在后面别处布局的）。
  assert.ok(
    main.includes('if (measure || o.keepScroll) {'),
    '⛔ `t5b` 的强制布局被改成无条件执行了（打开文档那条路会多一次同步布局）'
  );

  // ③ 唯一的调用点，且 `rerender` 判据取的是 `keepScroll`（提交后重渲）。
  const calls = main.split('RB.notice(').length - 1;
  assert.strictEqual(calls, 1, `⛔ \`RB.notice(\` 应恰好 1 处，实测 ${calls} 处`);
  const at = main.indexOf('RB.notice(');
  const call = main.slice(at, at + 400);
  assert.ok(call.includes('t5_ms: t5.ms'), '⛔ 没把 `t5` 的耗时喂进去');
  assert.ok(call.includes('t5b_ms: t5b.ms'), '⛔ 没把 `t5b` 的耗时喂进去');
  assert.ok(
    call.includes('rerender: !!o.keepScroll'),
    '⛔ `rerender` 判据必须取 `keepScroll`（⛔ 不能恒 `true`，那样打开文档也会说话）'
  );

  // ④ 加载期取值 ⇒ 脚本必须排在 `main.js` 之前，否则 `RB` 是 `undefined`，
  //    症状是**整个窗口空白**（`0009` 的 `search.js` 同族）。
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const rbAt = html.indexOf('<script src="services/renderbudget.js"></script>');
  const mainAt = html.indexOf('<script src="main.js"></script>');
  assert.ok(rbAt > 0, '⛔ `index.html` 里没有加载 `services/renderbudget.js`');
  assert.ok(mainAt > 0);
  assert.ok(rbAt < mainAt, '⛔ `services/renderbudget.js` 必须排在 `main.js` 之前');
});
