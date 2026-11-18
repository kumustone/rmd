// 左右滚动同步（`src/services/sync.js`, `design/0012` §11）。
//
// 从历史缺陷出发，守三族**静默**错误：
//   · `0006` 打字时预览栏上下晃 —— 程序写回被当成用户滚动，两栏互相推；
//   · `0077` 勾选任务项后正文跳到别的章节 —— 布局变了（图片落位）却继续用旧折线；
//   · 某一栏不可滚时把“采集到的锚点”当成“用得上的锚点”，回报一句精确的谎。
// 另外守折线的严格单调：倒挂的映射不可逆，表现成“往下滚另一栏却往上走”。
//
// 本文件只跑纯逻辑与可离屏的接线；真 DOM / 真 CM6 归 `make probe-scroll-sync`。
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
loadInto(win, 'src/services/sync.js');
const Y = win.rmd.sync;

// 假滚动容器：只提供 `上界()`、`写入()` 与事件登记用到的字段。
function elem(scrollHeight, clientHeight, scrollTop) {
  const handlers = Object.create(null);
  return {
    scrollHeight: scrollHeight,
    clientHeight: clientHeight,
    scrollTop: scrollTop || 0,
    handlers: handlers,
    addEventListener: function (type, fn) {
      (handlers[type] || (handlers[type] = [])).push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = handlers[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire: function (type) {
      const list = (handlers[type] || []).slice();
      for (const fn of list) fn();
    },
  };
}

function rafQueue() {
  let seq = 0;
  const pending = new Map();
  return {
    raf: function (fn) { seq += 1; pending.set(seq, fn); return seq; },
    cancelRaf: function (id) { pending.delete(id); },
    flush: function () {
      const fns = Array.from(pending.values());
      pending.clear();
      for (const fn of fns) fn();
    },
    size: function () { return pending.size; },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0006（打字时预览栏上下晃动）
// 变体：来源闸只认“值等不等于我写的”，⛔ 不用变化量阈值。
// ─────────────────────────────────────────────────────────────────────────

test('0006/常量和名字就是设计拍板的数', () => {
  assert.strictEqual(Y.ECHO_EPS, 1);
  assert.strictEqual(Y.ECHO_KEEP, 8);
  assert.strictEqual(Y.SRC, 'src');
  assert.strictEqual(Y.DST, 'dst');
});

test('0006/还没有人滚过时，谁先报滚动谁是来源', () => {
  const g = Y.createGuard('src', 'dst');
  assert.strictEqual(g.origin(), null);
  assert.strictEqual(g.accept('src', 10), true);
  assert.strictEqual(g.origin(), 'src');
});

test('0006/来源栏自己的滚动永远放行，值不必与写过的一致', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  g.noteWrite('src', 100);
  assert.strictEqual(g.accept('src', 100), true);
  assert.strictEqual(g.accept('src', 999), true);
});

test('0006/非来源栏的值恰好等于我写进去的 ⇒ 判成回声丢掉', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  g.noteWrite('dst', 250);
  assert.strictEqual(g.accept('dst', 250), false);
  assert.strictEqual(g.origin(), 'src', '回声不许把来源抢走');
});

test('0006/回声容差是 ±1 像素（含边界，不含 1.5）', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  g.noteWrite('dst', 100);
  assert.strictEqual(g.accept('dst', 99), false);
  assert.strictEqual(g.accept('dst', 101), false);
  assert.strictEqual(g.accept('dst', 101.5), true);
  assert.strictEqual(g.origin(), 'dst');
});

test('0006/非来源栏的值与写过的都不同 ⇒ 用户接管，来源移交', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  g.noteWrite('dst', 100);
  assert.strictEqual(g.accept('dst', 400), true);
  assert.strictEqual(g.origin(), 'dst');
});

test('0006/回声可能延后：记一串，迟到的旧回声仍认得', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  for (const v of [10, 20, 30, 40]) g.noteWrite('dst', v);
  assert.strictEqual(g.accept('dst', 10), false);
  assert.strictEqual(g.accept('dst', 20), false);
  assert.strictEqual(g.accept('dst', 40), false);
});

test('0006/只记最近 8 个：更早的回声已滚出窗口，会被当成用户接管', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  for (let i = 0; i <= 8; i++) g.noteWrite('dst', i * 10); // 0,10,…,80
  assert.strictEqual(g.accept('dst', 80), false, '最新的还在窗口里');
  assert.strictEqual(g.accept('dst', 0), true, '0 已被挤出窗口');
  assert.strictEqual(g.origin(), 'dst');
});

test('0006/非有限数的写入值不记（写 NaN 进 scrollTop 本来就会被浏览器忽略）', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  g.noteWrite('dst', NaN);
  g.noteWrite('dst', Infinity);
  g.noteWrite('dst', '100');
  assert.strictEqual(g.accept('dst', 100), true);
});

test('0006/显式移交（wheel / 指针 / 触摸）立刻换来源，不等 scroll', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  g.setOrigin('dst');
  assert.strictEqual(g.origin(), 'dst');
  g.setOrigin('src');
  assert.strictEqual(g.origin(), 'src');
});

test('0006/未知名字不认，也不改动来源', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  g.setOrigin('别的');
  assert.strictEqual(g.origin(), 'src');
  assert.strictEqual(g.accept('别的', 1), false);
  g.noteWrite('别的', 1);
  assert.strictEqual(g.accept('dst', 1), true);
});

test('0006/没给名字时用默认的 src / dst', () => {
  const g = Y.createGuard();
  g.setOrigin('src');
  assert.strictEqual(g.origin(), 'src');
  g.noteWrite('dst', 10);
  assert.strictEqual(g.accept('dst', 10), false);
});

test('0006/reset 清干净来源与回声队列（换文档 / 重建时）', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  g.noteWrite('dst', 10);
  g.reset();
  assert.strictEqual(g.origin(), null);
  assert.strictEqual(g.accept('dst', 10), true, '旧回声不许跨 reset 存活');
  assert.strictEqual(g.origin(), 'dst');
});

test('0006/非数滚动值永远不等于写过的值，按用户接管处理', () => {
  const g = Y.createGuard('src', 'dst');
  g.setOrigin('src');
  g.noteWrite('dst', 10);
  assert.strictEqual(g.accept('dst', NaN), true);
  assert.strictEqual(g.origin(), 'dst');
});

// ─────────────────────────────────────────────────────────────────────────
// 锚点配对：按 id，⛔ 不按序号
// ─────────────────────────────────────────────────────────────────────────

test('0006/按 id 配对：右侧表比大纲短时后面不整段错位', () => {
  const toc = [{ id: 'a', line: 1 }, { id: 'b', line: 5 }, { id: 'c', line: 9 }];
  const tops = [{ id: 'a', top: 0 }, { id: 'c', top: 300 }];
  const out = Y.pairAnchors(toc, tops, (line) => line * 10);
  assert.deepStrictEqual(out, [{ a: 10, b: 0 }, { a: 90, b: 300 }]);
});

test('0006/顺序无所谓：配对结果跟着 toc 的文档序', () => {
  const toc = [{ id: 'b', line: 2 }, { id: 'a', line: 1 }];
  const tops = [{ id: 'a', top: 100 }, { id: 'b', top: 200 }];
  assert.deepStrictEqual(Y.pairAnchors(toc, tops, (l) => l), [
    { a: 2, b: 200 },
    { a: 1, b: 100 },
  ]);
});

test('0006/查不到位置的标题整条丢掉，⛔ 不补 0', () => {
  const toc = [{ id: 'a', line: 1 }, { id: 'missing', line: 2 }, { id: 'b', line: 3 }];
  const tops = [{ id: 'a', top: 10 }, { id: 'b', top: 30 }];
  assert.deepStrictEqual(Y.pairAnchors(toc, tops, (l) => l * 10), [
    { a: 10, b: 10 },
    { a: 30, b: 30 },
  ]);
});

test('0006/lineTop 返回 null / 负数 / NaN / 抛异常都整条丢掉', () => {
  const toc = [{ id: 'a', line: 1 }, { id: 'b', line: 2 }, { id: 'c', line: 3 }, { id: 'd', line: 4 }];
  const tops = [{ id: 'a', top: 1 }, { id: 'b', top: 2 }, { id: 'c', top: 3 }, { id: 'd', top: 4 }];
  const out = Y.pairAnchors(toc, tops, function (line) {
    if (line === 1) return null;
    if (line === 2) return -1;
    if (line === 3) return NaN;
    throw new Error('boom');
  });
  assert.deepStrictEqual(out, []);
});

test('0006/坏行 / 非法 id / 非有限 top 都被跳过', () => {
  const toc = [null, {}, { id: '', line: 1 }, { id: 7, line: 2 }, { id: 'ok', line: 3 }];
  const tops = [null, { id: 'ok', top: NaN }, { id: '', top: 5 }, { id: 'ok', top: 50 }];
  assert.deepStrictEqual(Y.pairAnchors(toc, tops, (l) => l), [{ a: 3, b: 50 }]);
});

test('0006/行号必须从 1 起且为有限数；小数原样交给 lineTop（取整是它的事）', () => {
  const toc = [{ id: 'a', line: 0 }, { id: 'b', line: -2 }, { id: 'c', line: 1.5 }, { id: 'd', line: '3' }, { id: 'e', line: 4 }];
  const tops = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id: id, top: 1 }));
  assert.deepStrictEqual(Y.pairAnchors(toc, tops, (l) => l * 10), [
    { a: 15, b: 1 },
    { a: 40, b: 1 },
  ]);
});

test('0006/toc / tops 不是数组、lineTop 不是函数时安全返回空', () => {
  assert.deepStrictEqual(Y.pairAnchors(null, null, null), []);
  assert.deepStrictEqual(Y.pairAnchors([{ id: 'a', line: 1 }], [{ id: 'a', top: 1 }], null), []);
  assert.deepStrictEqual(Y.pairAnchors([], [], (l) => l), []);
});

test('0006/重复 id 的右侧位置以后出现的为准（表语义）', () => {
  const toc = [{ id: 'a', line: 1 }];
  const tops = [{ id: 'a', top: 10 }, { id: 'a', top: 20 }];
  assert.deepStrictEqual(Y.pairAnchors(toc, tops, (l) => l), [{ a: 1, b: 20 }]);
});

// ─────────────────────────────────────────────────────────────────────────
// 折线：两端补点、两轴严格递增、越界整条丢
// ─────────────────────────────────────────────────────────────────────────

test('0077/无标题文档退化成按比例：只剩两个端点', () => {
  assert.deepStrictEqual(Y.buildKnots([], 1000, 500), [{ a: 0, b: 0 }, { a: 1000, b: 500 }]);
  assert.deepStrictEqual(Y.buildKnots(null, 1000, 500), [{ a: 0, b: 0 }, { a: 1000, b: 500 }]);
});

test('0077/某一栏不可滚时折线到此饱和，⛔ 不补出零长段', () => {
  assert.deepStrictEqual(Y.buildKnots([{ a: 10, b: 10 }], 1000, 0), [{ a: 0, b: 0 }]);
  assert.deepStrictEqual(Y.buildKnots([{ a: 10, b: 10 }], 0, 500), [{ a: 0, b: 0 }]);
  assert.deepStrictEqual(Y.buildKnots([], 0, 0), [{ a: 0, b: 0 }]);
});

test('0077/锚点乱序时先按 a 再按 b 排，折线仍单调', () => {
  assert.deepStrictEqual(
    Y.buildKnots([{ a: 50, b: 25 }, { a: 10, b: 5 }], 100, 50),
    [{ a: 0, b: 0 }, { a: 10, b: 5 }, { a: 50, b: 25 }, { a: 100, b: 50 }]
  );
});

test('0077/同一 a 的重合点丢掉；b 相对上一点倒退的点也丢掉（⛔ 只判一个轴）', () => {
  assert.deepStrictEqual(
    Y.buildKnots([{ a: 10, b: 5 }, { a: 10, b: 9 }, { a: 30, b: 15 }], 100, 50),
    [{ a: 0, b: 0 }, { a: 10, b: 5 }, { a: 30, b: 15 }, { a: 100, b: 50 }],
    '同一 a 的第二个点丢掉'
  );
  assert.deepStrictEqual(
    Y.buildKnots([{ a: 10, b: 9 }, { a: 20, b: 8 }], 100, 50),
    [{ a: 0, b: 0 }, { a: 10, b: 9 }, { a: 100, b: 50 }],
    'b 从 9 退到 8 的点丢掉（否则倒挂）'
  );
});

test('0077/触到任一边界的锚点丢掉，尾点只补一次', () => {
  assert.deepStrictEqual(
    Y.buildKnots([{ a: 100, b: 10 }, { a: 20, b: 50 }, { a: 5, b: 5 }], 100, 50),
    [{ a: 0, b: 0 }, { a: 5, b: 5 }, { a: 100, b: 50 }]
  );
});

test('0077/超出上界的坐标先夹取：内容变短时浏览器会把 top 弹回来', () => {
  const out = Y.buildKnots([{ a: 500, b: 500 }], 100, 50);
  assert.deepStrictEqual(out, [{ a: 0, b: 0 }, { a: 100, b: 50 }]);
  for (const k of out) {
    assert.ok(k.a <= 100 && k.b <= 50);
  }
});

test('0077/两轴都严格递增（这是可逆的前提）', () => {
  const out = Y.buildKnots([
    { a: 10, b: 5 }, { a: 40, b: 20 }, { a: 70, b: 35 },
  ], 100, 50);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].a > out[i - 1].a, 'a 严格递增');
    assert.ok(out[i].b > out[i - 1].b, 'b 严格递增');
  }
});

test('0077/非法坐标 / 非数组 / 非数上界都安全', () => {
  assert.deepStrictEqual(Y.buildKnots([null, { a: NaN, b: 1 }, { a: 1, b: Infinity }, { a: '2', b: 2 }], 100, 50),
    [{ a: 0, b: 0 }, { a: 100, b: 50 }]);
  assert.deepStrictEqual(Y.buildKnots([{ a: 10, b: 5 }], -5, NaN), [{ a: 0, b: 0 }]);
});

test('0077/单个锚点把折线分成两段', () => {
  assert.deepStrictEqual(Y.buildKnots([{ a: 10, b: 5 }], 100, 50),
    [{ a: 0, b: 0 }, { a: 10, b: 5 }, { a: 100, b: 50 }]);
});

// ─────────────────────────────────────────────────────────────────────────
// 取值：段内线性插值 + 两端饱和，⛔ 不外推
// ─────────────────────────────────────────────────────────────────────────

const K = [{ a: 0, b: 0 }, { a: 100, b: 50 }, { a: 200, b: 150 }];

test('0006/空折线返回 0（⛔ 不返回 NaN 写进 scrollTop）', () => {
  assert.strictEqual(Y.mapValue([], 50, 'a'), 0);
  assert.strictEqual(Y.mapValue(null, 50, 'a'), 0);
});

test('0006/单个点的折线恒定返回另一个轴的值', () => {
  assert.strictEqual(Y.mapValue([{ a: 7, b: 9 }], 999, 'a'), 9);
  assert.strictEqual(Y.mapValue([{ a: 7, b: 9 }], 999, 'b'), 7);
});

test('0006/段内线性插值：两段斜率不同', () => {
  assert.strictEqual(Y.mapValue(K, 25, 'a'), 12.5);
  assert.strictEqual(Y.mapValue(K, 50, 'a'), 25);
  assert.strictEqual(Y.mapValue(K, 150, 'a'), 100);
});

test('0006/反向取值：预览滚到哪里回推源码栏', () => {
  assert.strictEqual(Y.mapValue(K, 25, 'b'), 50);
  assert.strictEqual(Y.mapValue(K, 100, 'b'), 150);
});

test('0006/两端饱和，⛔ 不做外推', () => {
  assert.strictEqual(Y.mapValue(K, -100, 'a'), 0);
  assert.strictEqual(Y.mapValue(K, 0, 'a'), 0);
  assert.strictEqual(Y.mapValue(K, 200, 'a'), 150);
  assert.strictEqual(Y.mapValue(K, 9999, 'a'), 150);
  assert.strictEqual(Y.mapValue(K, -100, 'b'), 0);
  assert.strictEqual(Y.mapValue(K, 9999, 'b'), 200);
});

test('0006/非数输入回顶部（唯一说得过去的解释）', () => {
  assert.strictEqual(Y.mapValue(K, NaN, 'a'), 0);
  assert.strictEqual(Y.mapValue(K, Infinity, 'a'), 0);
  assert.strictEqual(Y.mapValue(K, '50', 'a'), 0);
  assert.strictEqual(Y.mapValue(K, null, 'a'), 0);
});

test('0006/未知 axis 按 a 处理，⛔ 不静默反着映射', () => {
  assert.strictEqual(Y.mapValue(K, 50, 'x'), 25);
  assert.strictEqual(Y.mapValue(K, 50, undefined), 25);
});

// ─────────────────────────────────────────────────────────────────────────
// 接线：createDriver 的合流、代数、回声与“精确”回报
// ─────────────────────────────────────────────────────────────────────────

function driverFixture(over) {
  const s = elem(2000, 100);
  const p = elem(1000, 100);
  const q = rafQueue();
  const opts = Object.assign({
    src: () => s,
    dst: () => p,
    lineTop: (line) => line * 10,
    toc: () => [{ id: 'a', line: 10 }, { id: 'b', line: 19 }],
    headingTops: () => [{ id: 'a', top: 45 }, { id: 'b', top: 450 }],
    fresh: () => true,
    raf: q.raf,
    cancelRaf: q.cancelRaf,
  }, over || {});
  return { driver: Y.createDriver(opts), s, p, q, opts };
}

test('0077/start 后同步建折线：2 个锚点都留下', () => {
  const f = driverFixture();
  f.driver.start();
  assert.deepStrictEqual(f.driver.state(), {
    running: true, knots: 4, anchors: 2, used: 2, exact: true, origin: null,
  });
  assert.deepStrictEqual(f.driver.state().exact, true);
});

test('0077/布局未对应当前源码（fresh=false）时只按比例，⛔ 不用旧行号', () => {
  const f = driverFixture({ fresh: () => false });
  f.driver.start();
  assert.deepStrictEqual(f.driver.state(), {
    running: true, knots: 2, anchors: 0, used: 0, exact: false, origin: null,
  });
});

test('0077/某一栏不可滚：采集到锚点但一个都没留下，⛔ 不谎报精确', () => {
  const f = driverFixture();
  f.p.scrollHeight = 100;
  f.p.clientHeight = 100; // 预览栏不可滚
  f.driver.start();
  assert.deepStrictEqual(f.driver.state(), {
    running: true, knots: 1, anchors: 2, used: 0, exact: false, origin: null,
  });
});

test('0077/没有容器时 start 不进入运行态', () => {
  const f = driverFixture({ dst: () => null });
  f.driver.start();
  assert.strictEqual(f.driver.state().running, false);
  assert.strictEqual(f.driver.state().knots, 0);
});

test('0077/重复 start 是 no-op（监听不重复挂）', () => {
  const f = driverFixture();
  f.driver.start();
  f.driver.start();
  assert.strictEqual(f.s.handlers.scroll.length, 1);
  assert.strictEqual(f.p.handlers.scroll.length, 1);
});

test('0077/连来多次布局通知只重建一次（rAF 合流）', () => {
  let calls = 0;
  const f = driverFixture({ lineTop: (line) => { calls += 1; return line * 10; } });
  f.driver.start();
  const afterStart = calls;
  f.driver.schedule();
  f.driver.schedule();
  f.driver.schedule();
  assert.strictEqual(calls, afterStart, '合流期间不重建');
  assert.strictEqual(f.q.size(), 1);
  f.q.flush();
  assert.strictEqual(calls, afterStart + 2, '一次重建，每条锚点各调一次 lineTop');
});

test('0077/stop 后迟到的 rAF 不许拿旧容器重建', () => {
  const f = driverFixture();
  f.driver.start();
  f.driver.schedule();
  f.driver.stop();
  f.q.flush();
  assert.deepStrictEqual(f.driver.state(), {
    running: false, knots: 0, anchors: 0, used: 0, exact: false, origin: null,
  });
});

test('0077/stop 撤掉滚动监听与 onChange 退订，之后事件不再驱动', () => {
  let unsub = 0;
  const f = driverFixture({ onChange: () => () => { unsub += 1; } });
  f.driver.start();
  f.driver.stop();
  assert.strictEqual(unsub, 1);
  assert.strictEqual(f.s.handlers.scroll.length, 0);
  assert.strictEqual(f.p.handlers.scroll.length, 0);
  f.s.scrollTop = 1000;
  f.s.fire('scroll');
  assert.strictEqual(f.p.scrollTop, 0);
});

test('0077/再次 start 会复位来源并重新建折线', () => {
  const f = driverFixture();
  f.driver.start();
  f.s.scrollTop = 1000;
  f.s.fire('scroll');
  assert.strictEqual(f.driver.state().origin, Y.SRC);
  f.driver.stop();
  f.driver.start();
  assert.strictEqual(f.driver.state().origin, null);
  assert.strictEqual(f.driver.state().exact, true);
});

test('0077/源码栏滚动驱动预览栏', () => {
  const f = driverFixture();
  f.driver.start();
  f.s.scrollTop = 1900; // 到底
  f.s.fire('scroll');
  assert.strictEqual(f.driver.state().origin, Y.SRC);
  assert.strictEqual(f.p.scrollTop, 900, '折线尾点 (1900, 900)');
});

test('0077/预览栏用户滚动时来源及时移交，并回推源码栏', () => {
  const f = driverFixture();
  f.driver.start();
  f.s.scrollTop = 190;
  f.s.fire('scroll'); // 来源 = src；190 正好落在第二个锚点上
  assert.strictEqual(f.p.scrollTop, 450);
  f.p.scrollTop = 700; // 用户直接拖预览
  f.p.fire('scroll');
  assert.strictEqual(f.driver.state().origin, Y.DST);
  assert.ok(f.s.scrollTop > 190, '源码栏被预览栏回推');
  assert.ok(f.s.scrollTop <= 1900);
});

test('0077/写入预览走同一条回声登记：随后的 scroll 不被当成用户接管', () => {
  const f = driverFixture();
  f.driver.start();
  f.s.scrollTop = 190;
  f.s.fire('scroll');
  f.driver.写入预览(500);
  assert.strictEqual(f.p.scrollTop, 500);
  const before = f.s.scrollTop;
  f.p.fire('scroll'); // 浏览器为上面那次写入派发的回声
  assert.strictEqual(f.driver.state().origin, Y.SRC, '来源不许被回声翻走');
  assert.strictEqual(f.s.scrollTop, before, '源码栏不许被回声拽动');
});

test('0077/写入预览夹到当前上界，并记账', () => {
  const f = driverFixture();
  f.driver.start();
  f.driver.写入预览(99999);
  assert.strictEqual(f.p.scrollTop, 900);
  f.p.fire('scroll');
  assert.strictEqual(f.p.scrollTop, 900, '回声不再触发第二轮');
});

test('0077/写 NaN 进不来：夹取回落到 0', () => {
  const f = driverFixture();
  f.driver.start();
  f.s.scrollTop = NaN;
  f.s.fire('scroll');
  assert.strictEqual(f.p.scrollTop, 0);
});

test('0077/折线还没建好时收到滚动会补建，⛔ 不拿 null 去映射', () => {
  const f = driverFixture();
  f.driver.start();
  f.driver.stop();
  f.driver.start();
  f.s.scrollTop = 1900;
  f.s.fire('scroll');
  assert.strictEqual(f.p.scrollTop, 900);
});

test('0077/start 时元素取值器抛异常不炸（取不到就当没有）', () => {
  const f = driverFixture({ src: () => { throw new Error('gone'); } });
  assert.doesNotThrow(() => f.driver.start());
  assert.strictEqual(f.driver.state().running, false);
});

// ─────────────────────────────────────────────────────────────────────────
// 源码行 → 内容坐标：越界 / 缺件 / 抛异常都给 null，⛔ 不补 0
// ─────────────────────────────────────────────────────────────────────────

function fakeView(lines, topOf, throwAt) {
  return {
    state: {
      doc: {
        lines: lines,
        line: function (n) { return { from: n * 100 }; },
      },
    },
    lineBlockAt: function (from) {
      if (from === throwAt) throw new Error('bad pos');
      return topOf(from);
    },
  };
}

test('0077/sourceLineTopOf 用 lineBlockAt 给内容坐标，行号先取整', () => {
  const seen = [];
  const view = fakeView(10, (from) => ({ top: from + 7 }));
  view.lineBlockAt = (from) => { seen.push(from); return { top: from + 7 }; };
  assert.strictEqual(Y.sourceLineTopOf(view, 2.9), 207);
  assert.deepStrictEqual(seen, [200]);
});

test('0077/sourceLineTopOf 越界 / 非数 / 非正行号都给 null', () => {
  const view = fakeView(10, () => ({ top: 1 }));
  for (const line of [0, -1, 11, NaN, Infinity, '2', null, undefined]) {
    assert.strictEqual(Y.sourceLineTopOf(view, line), null, String(line));
  }
});

test('0077/sourceLineTopOf 视图缺件 / 换算抛异常 / top 非有限都给 null', () => {
  assert.strictEqual(Y.sourceLineTopOf(null, 1), null);
  assert.strictEqual(Y.sourceLineTopOf({}, 1), null);
  assert.strictEqual(Y.sourceLineTopOf(fakeView(10, () => ({ top: 1 }), 100), 1), null);
  assert.strictEqual(Y.sourceLineTopOf(fakeView(10, () => null), 1), null);
  assert.strictEqual(Y.sourceLineTopOf(fakeView(10, () => ({ top: NaN })), 1), null);
  assert.strictEqual(Y.sourceLineTopOf(fakeView(10, () => ({ top: '3' })), 1), null);
});

test('0077/sourceLineTopOf 允许 0 与负的 top（内容坐标可以高于视口）', () => {
  assert.strictEqual(Y.sourceLineTopOf(fakeView(10, () => ({ top: 0 })), 1), 0);
  assert.strictEqual(Y.sourceLineTopOf(fakeView(10, () => ({ top: -5 })), 1), -5);
});
