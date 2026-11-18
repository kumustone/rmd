// 左右滚动同步（`src/services/sync.js`）的自动化用例。
//
// 守的是一族**静默**失败：锚点按序号配错、折线出现零长段/倒挂、
// 端点外推被浏览器弹回、程序写的回声被当成用户滚动 —— 屏幕上都没有报错，
// 只有“同步在动，但不太准”或“滚下去另一栏却往上走”。
//
// ⚠️ 加载方式：产品文件是浏览器经典脚本（IIFE 挂 `window.rmd`）。
//    Node 26 把 `module` / `require` 暴露成了全局，若不显式遮蔽，源码会走
//    CommonJS 分支并尝试 `require('./…')`。这里把这两个形参传成 `undefined`，
//    强制走 `window` 分支（⛔ 不是 require 产品文件）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'sync.js'), 'utf8');
  const win = {};
  new Function('window', 'module', 'require', src)(win, undefined, undefined);
  return win.rmd.sync;
}

const SY = load();
const { pairAnchors, buildKnots, mapValue, createGuard, createDriver, sourceLineTopOf } = SY;

/** 行号 n 的像素 = (n − 1) × 20。 */
function lineTop20(line) { return (line - 1) * 20; }

// ─────────────────────────────────────────────────────────────────────────
// pairAnchors：大纲项 × 预览标题位置
// ─────────────────────────────────────────────────────────────────────────

test('pairAnchors 按 id 配对，⛔ 不按数组序号', () => {
  const toc = [{ id: 'a', line: 1 }, { id: 'b', line: 5 }, { id: 'c', line: 9 }];
  const tops = [{ id: 'a', top: 0 }, { id: 'b', top: 100 }, { id: 'c', top: 300 }];
  assert.deepStrictEqual(pairAnchors(toc, tops, lineTop20), [
    { a: 0, b: 0 }, { a: 80, b: 100 }, { a: 160, b: 300 },
  ]);
});

test('pairAnchors 右侧缺一条时，后面不会整体错位', () => {
  // 缺 b 时若按序号配，会得到 b↔300、c↔undefined —— 这里钉死“按 id 跳过错位”。
  const toc = [{ id: 'a', line: 1 }, { id: 'b', line: 5 }, { id: 'c', line: 9 }];
  const tops = [{ id: 'a', top: 0 }, { id: 'c', top: 300 }];
  assert.deepStrictEqual(pairAnchors(toc, tops, lineTop20), [
    { a: 0, b: 0 }, { a: 160, b: 300 },
  ]);
});

test('pairAnchors lineTop 抛异常的那一条整条丢掉', () => {
  const toc = [{ id: 'a', line: 1 }, { id: 'b', line: 5 }, { id: 'c', line: 9 }];
  const tops = [{ id: 'a', top: 0 }, { id: 'b', top: 100 }, { id: 'c', top: 300 }];
  const out = pairAnchors(toc, tops, function (line) {
    if (line === 5) throw new Error('视图已拆');
    return lineTop20(line);
  });
  assert.deepStrictEqual(out, [{ a: 0, b: 0 }, { a: 160, b: 300 }]);
});

test('pairAnchors lineTop 返回 null / NaN / 负数都不补 0', () => {
  const toc = [{ id: 'a', line: 1 }, { id: 'b', line: 2 }, { id: 'c', line: 3 }];
  const tops = [{ id: 'a', top: 0 }, { id: 'b', top: 10 }, { id: 'c', top: 20 }];
  const vals = { 1: null, 2: NaN, 3: -1 };
  assert.deepStrictEqual(pairAnchors(toc, tops, (n) => vals[n]), []);
});

test('pairAnchors 重复标题靠后端 id（intro / intro-1）天然分开', () => {
  const toc = [{ id: 'intro', line: 1 }, { id: 'intro-1', line: 7 }];
  const tops = [{ id: 'intro', top: 0 }, { id: 'intro-1', top: 400 }];
  assert.deepStrictEqual(pairAnchors(toc, tops, lineTop20), [
    { a: 0, b: 0 }, { a: 120, b: 400 },
  ]);
});

test('pairAnchors 跳级标题只是普通锚点，没有层级概念', () => {
  const toc = [{ id: 'h1', line: 1 }, { id: 'h3', line: 3 }];
  const tops = [{ id: 'h1', top: 0 }, { id: 'h3', top: 60 }];
  assert.deepStrictEqual(pairAnchors(toc, tops, lineTop20), [
    { a: 0, b: 0 }, { a: 40, b: 60 },
  ]);
});

test('pairAnchors 非数组输入与缺 lineTop 都返回空表', () => {
  assert.deepStrictEqual(pairAnchors(null, null, lineTop20), []);
  assert.deepStrictEqual(pairAnchors('x', 'y', lineTop20), []);
  assert.deepStrictEqual(pairAnchors([{ id: 'a', line: 1 }], [{ id: 'a', top: 0 }], null), []);
});

test('pairAnchors 行号 0 / 负数 / 小数以下 / 字符串一律丢', () => {
  const toc = [
    { id: 'a', line: 0 }, { id: 'b', line: -1 }, { id: 'c', line: NaN },
    { id: 'd', line: '4' }, { id: 'e', line: 9 },
  ];
  const tops = [
    { id: 'a', top: 0 }, { id: 'b', top: 0 }, { id: 'c', top: 0 },
    { id: 'd', top: 0 }, { id: 'e', top: 300 },
  ];
  assert.deepStrictEqual(pairAnchors(toc, tops, lineTop20), [{ a: 160, b: 300 }]);
});

test('pairAnchors 表项的 id 必须是非空字符串', () => {
  const toc = [{ id: '', line: 1 }, { id: 7, line: 1 }, { id: 'ok', line: 1 }];
  const tops = [{ id: '', top: 99 }, { id: 7, top: 99 }, { id: 'ok', top: 5 }];
  assert.deepStrictEqual(pairAnchors(toc, tops, lineTop20), [{ a: 0, b: 5 }]);
});

test('pairAnchors 表项的 top 非数 / NaN / Infinity 被跳过', () => {
  const toc = [{ id: 'a', line: 1 }, { id: 'b', line: 2 }, { id: 'c', line: 3 }];
  const tops = [
    { id: 'a', top: '0' }, { id: 'b', top: NaN }, { id: 'c', top: Infinity },
  ];
  assert.deepStrictEqual(pairAnchors(toc, tops, lineTop20), []);
});

test('pairAnchors 同一 id 出现两次时后者覆盖前者', () => {
  const toc = [{ id: 'a', line: 1 }];
  const tops = [{ id: 'a', top: 10 }, { id: 'a', top: 20 }];
  assert.deepStrictEqual(pairAnchors(toc, tops, lineTop20), [{ a: 0, b: 20 }]);
});

test('pairAnchors 输出保持大纲的文档序，而不是像素序', () => {
  const toc = [{ id: 'b', line: 9 }, { id: 'a', line: 1 }];
  const tops = [{ id: 'a', top: 0 }, { id: 'b', top: 300 }];
  assert.deepStrictEqual(pairAnchors(toc, tops, lineTop20), [
    { a: 160, b: 300 }, { a: 0, b: 0 },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// buildKnots：锚点对 → 单调折线
// ─────────────────────────────────────────────────────────────────────────

test('buildKnots 空锚点补两端点，退化成按比例', () => {
  assert.deepStrictEqual(buildKnots([], 1000, 400), [
    { a: 0, b: 0 }, { a: 1000, b: 400 },
  ]);
});

test('buildKnots 两轴都严格递增：a 重合的那条丢掉', () => {
  const k = buildKnots([
    { a: 100, b: 50 }, { a: 100, b: 80 }, { a: 300, b: 90 },
  ], 1000, 800);
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 }, { a: 100, b: 50 }, { a: 300, b: 90 }, { a: 1000, b: 800 },
  ]);
});

test('buildKnots b 倒退（倒挂）的锚点丢掉', () => {
  const k = buildKnots([
    { a: 100, b: 200 }, { a: 200, b: 100 }, { a: 300, b: 300 },
  ], 1000, 800);
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 }, { a: 100, b: 200 }, { a: 300, b: 300 }, { a: 1000, b: 800 },
  ]);
});

test('buildKnots 触到任一边界的锚点丢掉，尾点仍补上', () => {
  const k = buildKnots([{ a: 1000, b: 800 }, { a: 500, b: 400 }], 1000, 800);
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 }, { a: 500, b: 400 }, { a: 1000, b: 800 },
  ]);
});

test('buildKnots 预览不可滚时折线只剩一个点', () => {
  assert.deepStrictEqual(buildKnots([{ a: 100, b: 0 }, { a: 400, b: 0 }], 1000, 0), [
    { a: 0, b: 0 },
  ]);
});

test('buildKnots 源码不可滚时同样只剩一个点', () => {
  assert.deepStrictEqual(buildKnots([{ a: 0, b: 100 }], 0, 800), [{ a: 0, b: 0 }]);
});

test('buildKnots 乱序输入会先按 a 再按 b 排好', () => {
  const k = buildKnots([{ a: 400, b: 300 }, { a: 100, b: 50 }], 1000, 800);
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 }, { a: 100, b: 50 }, { a: 400, b: 300 }, { a: 1000, b: 800 },
  ]);
});

test('buildKnots 负数 / NaN / 非数的锚点被过滤', () => {
  const k = buildKnots([
    { a: -1, b: 10 }, { a: 100, b: NaN }, { a: '200', b: 80 }, { a: 300, b: 90 },
  ], 1000, 800);
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 }, { a: 300, b: 90 }, { a: 1000, b: 800 },
  ]);
});

test('buildKnots 超出上界的锚点先夹进范围，再按边界规则丢掉', () => {
  const k = buildKnots([{ a: 5000, b: 9000 }], 1000, 800);
  assert.deepStrictEqual(k, [{ a: 0, b: 0 }, { a: 1000, b: 800 }]);
});

test('buildKnots 上界非数按 0 处理，不会造出 NaN 折线', () => {
  assert.deepStrictEqual(buildKnots([], NaN, undefined), [{ a: 0, b: 0 }]);
});

test('buildKnots 锚点数组不是数组时仍返回两个端点', () => {
  assert.deepStrictEqual(buildKnots(null, 1200, 600), [
    { a: 0, b: 0 }, { a: 1200, b: 600 },
  ]);
});

test('buildKnots 两个锚点落在同一 a 时只留 b 较小的那条', () => {
  const k = buildKnots([{ a: 200, b: 300 }, { a: 200, b: 100 }], 1000, 800);
  // 排序后 (200,100) 在前 ⇒ 留下它；(200,300) 的 a 不增 ⇒ 丢。
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 }, { a: 200, b: 100 }, { a: 1000, b: 800 },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// mapValue：折线上取值
// ─────────────────────────────────────────────────────────────────────────

test('mapValue 空折线返回 0（而不是 NaN）', () => {
  assert.strictEqual(mapValue([], 100, 'a'), 0);
  assert.strictEqual(mapValue(null, 100, 'b'), 0);
});

test('mapValue 端点饱和，⛔ 不外推', () => {
  const k = buildKnots([{ a: 100, b: 50 }, { a: 400, b: 300 }], 1000, 800);
  assert.strictEqual(mapValue(k, -100, 'a'), 0);
  assert.strictEqual(mapValue(k, 0, 'a'), 0);
  assert.strictEqual(mapValue(k, 99999, 'a'), 800);
  assert.strictEqual(mapValue(k, 1000, 'a'), 800);
});

test('mapValue 段内线性插值（首段 / 中段 / 尾段）', () => {
  const k = buildKnots([{ a: 100, b: 50 }, { a: 400, b: 300 }], 1000, 800);
  assert.strictEqual(mapValue(k, 50, 'a'), 25);
  assert.strictEqual(mapValue(k, 250, 'a'), 175);
  assert.strictEqual(mapValue(k, 700, 'a'), 550);
});

test('mapValue 反向（b → a）也要对', () => {
  const k = buildKnots([{ a: 100, b: 50 }, { a: 400, b: 300 }], 1000, 800);
  assert.strictEqual(mapValue(k, 175, 'b'), 250);
  assert.strictEqual(mapValue(k, 25, 'b'), 50);
  assert.strictEqual(mapValue(k, 99999, 'b'), 1000);
});

test('mapValue 往返单调，且永不越出另一轴的值域', () => {
  const k = buildKnots([{ a: 100, b: 50 }, { a: 400, b: 300 }], 1000, 800);
  let prev = -1;
  for (let v = 0; v <= 1000; v += 7) {
    const r = mapValue(k, v, 'a');
    assert.ok(r >= prev, `v=${v} 处映射倒挂`);
    assert.ok(r >= 0 && r <= 800, `v=${v} 处映射越界：${r}`);
    prev = r;
  }
});

test('mapValue 非数输入回落到首点的输出值', () => {
  const k = buildKnots([{ a: 100, b: 50 }], 1000, 800);
  assert.strictEqual(mapValue(k, NaN, 'a'), 0);
  assert.strictEqual(mapValue(k, undefined, 'a'), 0);
  assert.strictEqual(mapValue(k, 'abc', 'a'), 0);
  assert.strictEqual(mapValue(k, [], 'a'), 0);
});

test('mapValue 单点折线在两个方向都恒等于那个点', () => {
  assert.strictEqual(mapValue([{ a: 0, b: 0 }], 123, 'a'), 0);
  assert.strictEqual(mapValue([{ a: 0, b: 0 }], 123, 'b'), 0);
});

test('mapValue axis 不是 "b" 时一律按 "a" 处理', () => {
  const k = buildKnots([{ a: 100, b: 50 }], 1000, 800);
  assert.strictEqual(mapValue(k, 50, 'x'), 25);
  assert.strictEqual(mapValue(k, 50, undefined), 25);
});

// ─────────────────────────────────────────────────────────────────────────
// createGuard：回声识别与来源移交
// ─────────────────────────────────────────────────────────────────────────

test('guard 谁先动谁是源', () => {
  const g = createGuard('src', 'dst');
  assert.strictEqual(g.origin(), null);
  assert.strictEqual(g.accept('src', 10), true);
  assert.strictEqual(g.origin(), 'src');
});

test('guard 源栏连续事件全部接受', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  assert.strictEqual(g.accept('src', 30), true);
  assert.strictEqual(g.accept('src', 300), true);
});

test('guard 程序写回的回声被丢掉，且不抢走来源', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 250);
  assert.strictEqual(g.accept('dst', 250), false);
  assert.strictEqual(g.origin(), 'src');
});

test('guard 容差恰好 1px：±1 算回声，1 以上算用户接管', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 250);
  assert.strictEqual(g.accept('dst', 251), false);
  assert.strictEqual(g.accept('dst', 249), false);
  assert.strictEqual(g.accept('dst', 252), true);
  assert.strictEqual(g.origin(), 'dst');
});

test('guard 延后到达的旧回声仍被认出（不只记最后一个值）', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 500);
  g.noteWrite('dst', 600);
  g.noteWrite('dst', 700);
  assert.strictEqual(g.accept('dst', 500), false);
  assert.strictEqual(g.accept('dst', 600), false);
  assert.strictEqual(g.accept('dst', 700), false);
  assert.strictEqual(g.origin(), 'src');
});

test('guard 回声记满只顶掉最旧的那条', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  for (let i = 0; i < SY.ECHO_KEEP; i++) g.noteWrite('dst', 100 + i * 10);
  // 最近一批仍在
  assert.strictEqual(g.accept('dst', 100 + (SY.ECHO_KEEP - 1) * 10), false);
  // 最旧的已被顶掉 ⇒ 当成用户接管（保守方向，⛔ 不是死锁）
  assert.strictEqual(g.accept('dst', 5), true);
  assert.strictEqual(g.origin(), 'dst');
});

test('guard 非来源栏的陌生值 = 用户接管并反转角色', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 250);
  assert.strictEqual(g.accept('dst', 900), true);
  assert.strictEqual(g.origin(), 'dst');
  g.noteWrite('src', 40);
  assert.strictEqual(g.accept('src', 40), false);
  assert.strictEqual(g.origin(), 'dst');
});

test('guard 判据是相等，⛔ 不是变化量阈值', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 5000);
  assert.strictEqual(g.accept('dst', 5000), false);
  assert.strictEqual(g.origin(), 'src');
});

test('guard setOrigin 接收已知栏名，未知名字一律无效', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.setOrigin('dst');
  assert.strictEqual(g.origin(), 'dst');
  g.setOrigin('窗口');
  assert.strictEqual(g.origin(), 'dst', '未知名字覆盖了合法来源');
  g.setOrigin(null);
  assert.strictEqual(g.origin(), 'dst');
});

test('guard reset 清来源与回声表', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 250);
  g.reset();
  assert.strictEqual(g.origin(), null);
  assert.strictEqual(g.accept('dst', 250), true);
  assert.strictEqual(g.origin(), 'dst');
});

test('guard 非数事件不会被误判成回声', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 250);
  assert.strictEqual(g.accept('dst', NaN), true);
  assert.strictEqual(g.origin(), 'dst');
});

test('guard 不传栏名时默认就是 src / dst', () => {
  const g = createGuard();
  assert.strictEqual(g.accept('src', 1), true);
  g.noteWrite('dst', 2);
  assert.strictEqual(g.accept('dst', 2), false);
});

test('guard noteWrite 的非数 / 未知栏名不记账', () => {
  const g = createGuard('src', 'dst');
  g.noteWrite('窗口', 5);
  g.noteWrite('dst', NaN);
  g.noteWrite('dst', Infinity);
  // 上面三条都没入表 ⇒ 任何 dst 事件都是“用户接管”
  assert.strictEqual(g.accept('dst', 5), true);
  assert.strictEqual(g.origin(), 'dst');
});

// ─────────────────────────────────────────────────────────────────────────
// sourceLineTopOf：源码行 → 内容坐标
// ─────────────────────────────────────────────────────────────────────────

/** 最小假 CM6 视图：每行 5 个字符、行高 20。 */
function fakeView(lines, over) {
  const v = {
    state: {
      doc: {
        lines: lines,
        line: function (n) { return { from: (n - 1) * 5 }; },
      },
    },
    lineBlockAt: function (from) { return { top: (from / 5) * 20 }; },
  };
  if (over) for (const k in over) v[k] = over[k];
  return v;
}

test('sourceLineTopOf 行号换成内容坐标', () => {
  const v = fakeView(10);
  assert.strictEqual(sourceLineTopOf(v, 1), 0);
  assert.strictEqual(sourceLineTopOf(v, 4), 60);
});

test('sourceLineTopOf 越界 / 非数 / 字符串行号一律 null', () => {
  const v = fakeView(10);
  assert.strictEqual(sourceLineTopOf(v, 0), null);
  assert.strictEqual(sourceLineTopOf(v, -3), null);
  assert.strictEqual(sourceLineTopOf(v, 11), null);
  assert.strictEqual(sourceLineTopOf(v, NaN), null);
  assert.strictEqual(sourceLineTopOf(v, undefined), null);
  assert.strictEqual(sourceLineTopOf(v, '3'), null);
  assert.strictEqual(sourceLineTopOf(v, Infinity), null);
});

test('sourceLineTopOf 小数行号向下取整', () => {
  assert.strictEqual(sourceLineTopOf(fakeView(10), 4.7), 60);
});

test('sourceLineTopOf 视图缺件时返回 null，而不是抛', () => {
  assert.strictEqual(sourceLineTopOf(null, 1), null);
  assert.strictEqual(sourceLineTopOf({}, 1), null);
  assert.strictEqual(sourceLineTopOf({ state: {} }, 1), null);
  assert.strictEqual(sourceLineTopOf({ state: { doc: { lines: 3 } } }, 1), null);
});

test('sourceLineTopOf lineBlockAt 抛 / null / NaN 都返回 null，不补 0', () => {
  assert.strictEqual(sourceLineTopOf(fakeView(5, {
    lineBlockAt: function () { throw new Error('视图已拆'); },
  }), 2), null);
  assert.strictEqual(sourceLineTopOf(fakeView(5, {
    lineBlockAt: function () { return null; },
  }), 2), null);
  assert.strictEqual(sourceLineTopOf(fakeView(5, {
    lineBlockAt: function () { return { top: NaN }; },
  }), 2), null);
});

test('sourceLineTopOf 缺 doc.lines 或 doc.line 时返回 null', () => {
  const noLines = fakeView(5, {
    state: { doc: { line: function () { return { from: 0 }; } } },
  });
  const noLine = fakeView(5, { state: { doc: { lines: 5 } } });
  assert.strictEqual(sourceLineTopOf(noLines, 1), null);
  assert.strictEqual(sourceLineTopOf(noLine, 1), null);
});

// ─────────────────────────────────────────────────────────────────────────
// createDriver：接线（最小假 DOM + 假 rAF）
// ─────────────────────────────────────────────────────────────────────────

/** 够用的假滚动容器：⛔ 不自己派发 scroll（事件会迟到正是模型的一部分）。 */
function fakeEl(o) {
  const el = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    _ev: Object.create(null),
    addEventListener: function (t, f) {
      const a = (el._ev[t] || (el._ev[t] = []));
      if (a.indexOf(f) < 0) a.push(f);
    },
    removeEventListener: function (t, f) {
      const a = el._ev[t] || [];
      const i = a.indexOf(f);
      if (i >= 0) a.splice(i, 1);
    },
    fire: function (t) {
      const a = (el._ev[t] || []).slice();
      for (let i = 0; i < a.length; i++) a[i]({ type: t });
    },
    listenerCount: function () {
      let n = 0;
      for (const k in el._ev) n += el._ev[k].length;
      return n;
    },
  };
  if (o) for (const k in o) el[k] = o[k];
  return el;
}

function fakeRaf() {
  let q = [];
  return {
    raf: function (fn) { q.push(fn); return q.length; },
    cancel: function () { /* stop() 另有 running 兜底 */ },
    flush: function () { const a = q; q = []; for (let i = 0; i < a.length; i++) a[i](0); },
    pending: function () { return q.length; },
  };
}

/**
 * 标准两栏：maxA=1500 / maxB=2000，锚点 0→0、100→400
 * ⇒ 源码 800 恰好映射到预览 1200（段内比例 0.5）。
 */
function 搭一个(over) {
  const o = over || {};
  const srcEl = fakeEl({ scrollHeight: 2000, clientHeight: 500 });
  const dstEl = fakeEl({ scrollHeight: 3000, clientHeight: 1000 });
  const 时钟 = fakeRaf();
  const 布局钩子 = [];
  const st = { fresh: o.fresh !== false, src: srcEl, dst: dstEl };
  const drv = createDriver({
    src: function () { return st.src; },
    dst: function () { return st.dst; },
    lineTop: lineTop20,
    toc: function () { return [{ id: 'a', line: 1 }, { id: 'b', line: 6 }]; },
    headingTops: function () { return [{ id: 'a', top: 0 }, { id: 'b', top: 400 }]; },
    fresh: function () { return st.fresh; },
    onChange: function (cb) { 布局钩子.push(cb); return function () {}; },
    raf: 时钟.raf,
    cancelRaf: 时钟.cancel,
  });
  return { srcEl, dstEl, 时钟, 布局钩子, st, drv };
}

test('driver 起来就建折线，采集数与用上的锚点数分开报', () => {
  const t = 搭一个();
  t.drv.start();
  const s = t.drv.state();
  assert.strictEqual(s.running, true);
  assert.strictEqual(s.anchors, 2);
  assert.strictEqual(s.used, 1);
  assert.strictEqual(s.knots, 3);
  assert.strictEqual(s.exact, true);
});

test('driver 源码滚动时预览按折线走', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 800;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 1200);
});

test('driver 程序写进去的回声被吞，不会反弹', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 800;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 1200);
  const 写前的源 = t.srcEl.scrollTop;
  t.dstEl.fire('scroll');
  assert.strictEqual(t.srcEl.scrollTop, 写前的源, '回声把源码栏推动了');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
});

test('driver 连续驱动后迟到的旧回声仍被吞', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 300; t.srcEl.fire('scroll');
  const 甲 = t.dstEl.scrollTop;
  t.srcEl.scrollTop = 800; t.srcEl.fire('scroll');
  const 乙 = t.dstEl.scrollTop;
  t.srcEl.scrollTop = 1500; t.srcEl.fire('scroll');
  assert.notStrictEqual(甲, 乙);
  t.dstEl.scrollTop = 甲; t.dstEl.fire('scroll');
  t.dstEl.scrollTop = 乙; t.dstEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
});

test('driver 另一栏自己滚时及时移交来源', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 800; t.srcEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
  t.dstEl.scrollTop = 1900;
  t.dstEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.DST);
  assert.notStrictEqual(t.srcEl.scrollTop, 800);
});

test('driver 一碰哪一栏（wheel / pointerdown）就立刻移交', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 800; t.srcEl.fire('scroll');
  t.dstEl.fire('wheel');
  assert.strictEqual(t.drv.state().origin, SY.DST);
  t.srcEl.fire('pointerdown');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
});

test('driver 写进去的一定是夹取之后的值', () => {
  const t = 搭一个();
  t.dstEl.scrollHeight = 1000;
  t.dstEl.clientHeight = 1000;
  t.drv.start();
  t.srcEl.scrollTop = 1500;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 0, '不可滚的预览栏被写进了非 0');
});

test('driver 夹取之后的值才记账，否则回声认不出来', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 1500;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 2000);
  t.dstEl.scrollHeight = 1500;      // 上界掉到 500
  t.srcEl.scrollTop = 1500;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 500);
  t.dstEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.SRC, '夹取没记账 ⇒ 回声没认出来');
});

test('driver fresh 为假时降级成按比例', () => {
  const t = 搭一个();
  t.drv.start();
  assert.strictEqual(t.drv.state().exact, true);
  t.st.fresh = false;
  t.drv.rebuild();
  const s = t.drv.state();
  assert.strictEqual(s.exact, false);
  assert.strictEqual(s.anchors, 0);
  assert.strictEqual(s.knots, 2);
  t.srcEl.scrollTop = 750;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 1000);
});

test('driver fresh 恢复后精确性回来', () => {
  const t = 搭一个();
  t.drv.start();
  t.st.fresh = false;
  t.drv.rebuild();
  assert.strictEqual(t.drv.state().exact, false);
  t.st.fresh = true;
  t.drv.rebuild();
  assert.strictEqual(t.drv.state().exact, true);
  t.srcEl.scrollTop = 800;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 1200);
});

test('driver 布局变化走合流，一次 flush 只重建一次', () => {
  const t = 搭一个();
  t.drv.start();
  assert.strictEqual(t.布局钩子.length, 1);
  t.布局钩子[0]();
  t.布局钩子[0]();
  t.布局钩子[0]();
  assert.strictEqual(t.时钟.pending(), 1);
  t.dstEl.scrollHeight = 4000;
  t.时钟.flush();
  t.srcEl.scrollTop = 1500;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 3000);
});

test('driver 拆卸后监听全撤，迟到的 rAF 一律无效', () => {
  const t = 搭一个();
  t.drv.start();
  t.布局钩子[0]();
  assert.strictEqual(t.时钟.pending(), 1);
  t.drv.stop();
  t.时钟.flush();
  assert.strictEqual(t.srcEl.listenerCount(), 0);
  assert.strictEqual(t.dstEl.listenerCount(), 0);
  const s = t.drv.state();
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.knots, 0);
  assert.strictEqual(s.origin, null);
});

test('driver 拆卸之后再滚什么都不会发生', () => {
  const t = 搭一个();
  t.drv.start();
  t.drv.stop();
  t.srcEl.scrollTop = 900;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 0);
});

test('driver 重复 start 不重复挂监听；重新 start 会清干净来源闸', () => {
  const t = 搭一个();
  t.drv.start();
  const n = t.srcEl.listenerCount();
  t.drv.start();
  assert.strictEqual(t.srcEl.listenerCount(), n);
  t.srcEl.scrollTop = 800; t.srcEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
  t.drv.stop();
  t.drv.start();
  assert.strictEqual(t.drv.state().origin, null, '来源跨会话留了下来');
  t.dstEl.scrollTop = 1700;
  t.dstEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.DST);
});

test('driver 容器换了就驱动新容器', () => {
  const t = 搭一个();
  t.drv.start();
  const 新 = fakeEl({ scrollHeight: 3000, clientHeight: 1000 });
  t.st.dst = 新;
  t.srcEl.scrollTop = 800;
  t.srcEl.fire('scroll');
  assert.strictEqual(新.scrollTop, 1200);
  assert.strictEqual(t.dstEl.scrollTop, 0, '写到了已经不在用的元素上');
});

test('driver 容器还拿不到时 start 不半死', () => {
  const t = 搭一个();
  t.st.src = null;
  t.drv.start();
  assert.strictEqual(t.drv.state().running, false);
  assert.strictEqual(t.dstEl.listenerCount(), 0);
  t.st.src = t.srcEl;
  t.drv.start();
  assert.strictEqual(t.drv.state().running, true);
  t.srcEl.scrollTop = 800;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 1200);
});

test('driver 没有标题的文档照样按比例工作', () => {
  const 时钟 = fakeRaf();
  const srcEl = fakeEl({ scrollHeight: 2000, clientHeight: 500 });
  const dstEl = fakeEl({ scrollHeight: 3000, clientHeight: 1000 });
  const drv = createDriver({
    src: function () { return srcEl; },
    dst: function () { return dstEl; },
    lineTop: lineTop20,
    toc: function () { return []; },
    headingTops: function () { return []; },
    fresh: function () { return true; },
    raf: 时钟.raf, cancelRaf: 时钟.cancel,
  });
  drv.start();
  assert.strictEqual(drv.state().exact, false);
  assert.strictEqual(drv.state().anchors, 0);
  srcEl.scrollTop = 750;
  srcEl.fire('scroll');
  assert.strictEqual(dstEl.scrollTop, 1000);
});

test('driver 预览不可滚时用上的锚点是 0，exact 必须为假', () => {
  const 时钟 = fakeRaf();
  const srcEl = fakeEl({ scrollHeight: 2000, clientHeight: 500 });
  const dstEl = fakeEl({ scrollHeight: 800, clientHeight: 800 });
  const drv = createDriver({
    src: function () { return srcEl; },
    dst: function () { return dstEl; },
    lineTop: lineTop20,
    toc: function () { return [{ id: 'a', line: 1 }, { id: 'b', line: 6 }]; },
    headingTops: function () { return [{ id: 'a', top: 0 }, { id: 'b', top: 400 }]; },
    fresh: function () { return true; },
    raf: 时钟.raf, cancelRaf: 时钟.cancel,
  });
  drv.start();
  const s = drv.state();
  assert.strictEqual(s.anchors, 2);
  assert.strictEqual(s.used, 0);
  assert.strictEqual(s.knots, 1);
  assert.strictEqual(s.exact, false, '拿采集数冒充精确性');
  srcEl.scrollTop = 800;
  srcEl.fire('scroll');
  assert.strictEqual(dstEl.scrollTop, 0);
  assert.strictEqual(srcEl.scrollTop, 800, '回声把源码栏推动了');
});

test('driver 源码不可滚时同理：采集到了锚点但一条都用不上', () => {
  const 时钟 = fakeRaf();
  const srcEl = fakeEl({ scrollHeight: 500, clientHeight: 500 });
  const dstEl = fakeEl({ scrollHeight: 3000, clientHeight: 1000 });
  const drv = createDriver({
    src: function () { return srcEl; },
    dst: function () { return dstEl; },
    lineTop: lineTop20,
    toc: function () { return [{ id: 'a', line: 1 }, { id: 'b', line: 6 }]; },
    headingTops: function () { return [{ id: 'a', top: 0 }, { id: 'b', top: 400 }]; },
    fresh: function () { return true; },
    raf: 时钟.raf, cancelRaf: 时钟.cancel,
  });
  drv.start();
  const s = drv.state();
  assert.strictEqual(s.anchors, 2);
  assert.strictEqual(s.used, 0);
  assert.strictEqual(s.knots, 1);
  assert.strictEqual(s.exact, false);
});

test('driver 写入预览走同一条记账通道，其回声不会把来源抢走', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 800; t.srcEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
  t.drv.写入预览(500);
  assert.strictEqual(t.dstEl.scrollTop, 500);
  t.dstEl.fire('scroll');       // 这次写的迟到回声
  assert.strictEqual(t.drv.state().origin, SY.SRC, '提交时写回被当成了用户接管');
  assert.strictEqual(t.srcEl.scrollTop, 800);
});

test('driver 写入预览按写的那一刻的 DOM 夹取', () => {
  const t = 搭一个();
  t.dstEl.scrollHeight = 1200;
  t.dstEl.clientHeight = 1000;   // 上界 200
  t.drv.start();
  t.drv.写入预览(9999);
  assert.strictEqual(t.dstEl.scrollTop, 200);
});

test('driver 写入预览没有目标容器时安静返回', () => {
  const t = 搭一个();
  t.drv.start();
  t.st.dst = null;
  assert.doesNotThrow(() => t.drv.写入预览(100));
});

test('driver stop 之后 state 归零', () => {
  const t = 搭一个();
  t.drv.start();
  t.drv.stop();
  assert.deepStrictEqual(t.drv.state(), {
    running: false, knots: 0, anchors: 0, used: 0, exact: false, origin: null,
  });
});
