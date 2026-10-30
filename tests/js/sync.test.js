// 左右滚动同步的断言（`src/services/sync.js`，`design/0012` §11）。**70 条**，分四层：
//
// | 层 | 在哪 | 条数 |
// |---|---|---|
// | ⭐ **纯逻辑**（配锚点 / 折线 / 取值 / 来源闸） | 本文件上半 | 35 |
// | ⭐ **接线**（`createDriver`：监听、合流、夹取、拆卸） | 中间，**最小假 DOM** | 22 |
// | ⭐ **行 → 像素**（`sourceLineTopOf`） | 末尾，**最小假 CM6 视图** | 6 |
// | ⭐⭐ **源码级接线闸门** | **最末尾** | **7** |
//
// ⚠️ 那 7 条是：`src/main.js` 真的建了 driver（§11 三条里的第一条）＋ 预览栏经 `scrollHost()`
//    ＋ 进出编辑态各自挂/拆 ⇒ 再 ＋ `docs/bugs/0006` 的三条（提交那一刻的接线）
//    ⇒ ⭐ ＋ **`design/0019` §2.2** 的「`#preview-bar` 仍在 `.topbar` 内」——
//    最后这条**与滚动同步无关**，借这个文件的"源码级闸门"段落脚（同族：产品源码里的一跳）。
//
// ⚠️ 那 "22" 里含 ⭐ 「**采集到的锚点 ≠ 折线里用上的锚点**」那 4 条
//    （`exact` 判 `used` 而不是 `anchors`）——⛔ 别按旧记的 18 引用，那是那一节落地前的数。
//
// ⚠️ 它们守的**不是"算得对不对"这一件事**，而是四类**不会报错**的错：
//    ① 配错锚点 ⇒ 从某一条起**后面全错位**（看起来"同步在动，只是不太准"）；
//    ② 造出零长段 / 倒挂 ⇒ 除零、或"滚下去另一栏却往上走"；
//    ③ 端点外推 ⇒ 被浏览器弹回 ⇒ **看着像抖**；
//    ④ 回声没认出来 ⇒ 两栏互相推 ⇒ 抖 / 滚不动（`INV-EDIT-14`）。
//    ⭐ 四类的共同点是**屏幕上没有异常信息**，只有"手感不对"。
// ⚠️ ⛔ **那两个观察器在 node 里不存在**（`MutationObserver`/`ResizeObserver`，
//    `typeof` 判为假 ⇒ 驱动会跳过）⇒ 图片加载与容器尺寸那两条**只能**由
//    离屏探针在真 WKWebView 里覆盖（`make probe-scroll-sync`）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// ⚠️ 这个模块是给浏览器用的经典脚本（IIFE 挂 `window.rmd`），
//    所以拿一个假的 `window` 把它跑起来——⛔ 不是 `require` 一个 CommonJS 模块。
function load() {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'src', 'services', 'sync.js'),
    'utf8'
  );
  const win = {};
  new Function('window', src)(win);
  return win.rmd.sync;
}

const SY = load();
const { pairAnchors, buildKnots, mapValue, createGuard, createDriver } = SY;

/** 造一个 `lineTop`：行号 n 的像素 = (n − 1) × 20。 */
function lineTop20(line) { return (line - 1) * 20; }

test('pairAnchors_按_id_配对_不按序号', () => {
  const toc = [
    { id: 'a', line: 1 },
    { id: 'b', line: 5 },
    { id: 'c', line: 9 },
  ];
  const tops = [{ id: 'a', top: 0 }, { id: 'b', top: 100 }, { id: 'c', top: 300 }];
  const out = pairAnchors(toc, tops, lineTop20);
  assert.deepStrictEqual(out, [
    { a: 0, b: 0 },
    { a: 80, b: 100 },
    { a: 160, b: 300 },
  ]);
});

test('pairAnchors_右侧短一截时_其余不错位', () => {
  // ⚠️ 这是本文件最值钱的一条：`headingPositions()` 查不到的 id 会 continue
  //    ⇒ 右侧可能比 toc 短。按序号配的话从缺失点起**全错位且静默**。
  const toc = [
    { id: 'a', line: 1 },
    { id: 'b', line: 5 },
    { id: 'c', line: 9 },
  ];
  const tops = [{ id: 'a', top: 0 }, { id: 'c', top: 300 }];   // b 缺失
  const out = pairAnchors(toc, tops, lineTop20);
  assert.deepStrictEqual(out, [
    { a: 0, b: 0 },
    { a: 160, b: 300 },
  ]);
  // ⭐ 反证：按序号配会得到 b↔300、c↔undefined —— 断言它**没有**那么做
  assert.ok(!out.some((p) => typeof p.b !== 'number'));
});

test('pairAnchors_换算失败的那条整条丢掉_不补零', () => {
  const toc = [{ id: 'a', line: 1 }, { id: 'b', line: 5 }, { id: 'c', line: 9 }];
  const tops = [{ id: 'a', top: 0 }, { id: 'b', top: 100 }, { id: 'c', top: 300 }];
  const out = pairAnchors(toc, tops, function (line) {
    if (line === 5) throw new Error('越界');
    return lineTop20(line);
  });
  assert.deepStrictEqual(out, [{ a: 0, b: 0 }, { a: 160, b: 300 }]);
});

test('pairAnchors_lineTop_返回_null_时丢掉', () => {
  const toc = [{ id: 'a', line: 1 }, { id: 'b', line: 5 }];
  const tops = [{ id: 'a', top: 0 }, { id: 'b', top: 100 }];
  const out = pairAnchors(toc, tops, function () { return null; });
  assert.deepStrictEqual(out, []);
});

test('pairAnchors_重复标题靠_id_天然分开', () => {
  // ⭐ adr/0003 保证文档内 id 唯一（intro / intro-1）——这正是"按 id 配"成立的前提。
  const toc = [{ id: 'intro', line: 1 }, { id: 'intro-1', line: 7 }];
  const tops = [{ id: 'intro', top: 0 }, { id: 'intro-1', top: 400 }];
  const out = pairAnchors(toc, tops, lineTop20);
  assert.deepStrictEqual(out, [{ a: 0, b: 0 }, { a: 120, b: 400 }]);
});

test('pairAnchors_跳级标题没有特殊处理', () => {
  // h1 → h3，中间没有 h2；本文件里**没有"层级"这个概念**，也不该有。
  const toc = [{ id: 'h1', line: 1 }, { id: 'h3', line: 3 }];
  const tops = [{ id: 'h1', top: 0 }, { id: 'h3', top: 60 }];
  const out = pairAnchors(toc, tops, lineTop20);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].b, 60);
});

test('pairAnchors_空输入与坏输入都返回空表', () => {
  assert.deepStrictEqual(pairAnchors([], [], lineTop20), []);
  assert.deepStrictEqual(pairAnchors(null, null, lineTop20), []);
  assert.deepStrictEqual(pairAnchors([{ id: 'a', line: 1 }], [{ id: 'a', top: 0 }], null), []);
});

test('pairAnchors_行号非法的那条丢掉', () => {
  const toc = [{ id: 'a', line: 0 }, { id: 'b', line: NaN }, { id: 'c', line: 9 }];
  const tops = [{ id: 'a', top: 0 }, { id: 'b', top: 1 }, { id: 'c', top: 300 }];
  const out = pairAnchors(toc, tops, lineTop20);
  assert.deepStrictEqual(out, [{ a: 160, b: 300 }]);
});

test('buildKnots_无标题文档退化成按比例', () => {
  const k = buildKnots([], 1000, 400);
  assert.deepStrictEqual(k, [{ a: 0, b: 0 }, { a: 1000, b: 400 }]);
  // ⭐ 并且它**照常工作**（不是"没有映射"）——只是不假装精确
  assert.strictEqual(mapValue(k, 500, 'a'), 200);
  assert.strictEqual(mapValue(k, 200, 'b'), 500);
});

test('buildKnots_首尾各补一个点', () => {
  const k = buildKnots([{ a: 100, b: 50 }, { a: 400, b: 300 }], 1000, 800);
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 },
    { a: 100, b: 50 },
    { a: 400, b: 300 },
    { a: 1000, b: 800 },
  ]);
});

test('buildKnots_两轴严格递增_重合的锚点丢掉', () => {
  const k = buildKnots([
    { a: 100, b: 50 },
    { a: 100, b: 80 },   // a 重合 ⇒ 丢
    { a: 200, b: 50 },   // b 不增 ⇒ 丢（倒挂）
    { a: 300, b: 90 },
  ], 1000, 800);
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 },
    { a: 100, b: 50 },
    { a: 300, b: 90 },
    { a: 1000, b: 800 },
  ]);
});

test('buildKnots_触边界的锚点丢掉_不造零长段', () => {
  const k = buildKnots([{ a: 1000, b: 800 }, { a: 500, b: 400 }], 1000, 800);
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 },
    { a: 500, b: 400 },
    { a: 1000, b: 800 },
  ]);
  // ⭐ 反证：若那条边界锚点被留下，尾点就再也补不上 ⇒ 折线在 (1000,800) 处**缺一段**
  assert.strictEqual(k[k.length - 1].a, 1000);
  assert.strictEqual(k[k.length - 1].b, 800);
});

test('buildKnots_预览不可滚时折线饱和', () => {
  const k = buildKnots([{ a: 100, b: 0 }, { a: 400, b: 0 }], 1000, 0);
  assert.deepStrictEqual(k, [{ a: 0, b: 0 }]);
  assert.strictEqual(mapValue(k, 999, 'a'), 0);
});

test('buildKnots_源码不可滚时只有一个点', () => {
  const k = buildKnots([{ a: 0, b: 100 }], 0, 800);
  assert.deepStrictEqual(k, [{ a: 0, b: 0 }]);
  assert.strictEqual(mapValue(k, 0, 'a'), 0);
});

test('buildKnots_乱序输入会被排好', () => {
  const k = buildKnots([{ a: 400, b: 300 }, { a: 100, b: 50 }], 1000, 800);
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 },
    { a: 100, b: 50 },
    { a: 400, b: 300 },
    { a: 1000, b: 800 },
  ]);
});

test('buildKnots_负数与_NaN_被过滤', () => {
  const k = buildKnots([
    { a: -1, b: 10 }, { a: 100, b: NaN }, { a: 200, b: 80 },
  ], 1000, 800);
  assert.deepStrictEqual(k, [
    { a: 0, b: 0 },
    { a: 200, b: 80 },
    { a: 1000, b: 800 },
  ]);
});

test('buildKnots_超出上界的锚点被夹进来', () => {
  // ⚠️ 内容变短时浏览器会把 scrollTop 弹回去，量到的 top 可能大于当前上界。
  const k = buildKnots([{ a: 5000, b: 9000 }], 1000, 800);
  // 夹完就是 (1000, 800) ⇒ 与尾点重合 ⇒ 丢掉 ⇒ 只剩两个端点
  assert.deepStrictEqual(k, [{ a: 0, b: 0 }, { a: 1000, b: 800 }]);
});

test('mapValue_端点外饱和_不外推', () => {
  const k = buildKnots([{ a: 100, b: 50 }, { a: 400, b: 300 }], 1000, 800);
  assert.strictEqual(mapValue(k, -100, 'a'), 0);
  assert.strictEqual(mapValue(k, 0, 'a'), 0);
  assert.strictEqual(mapValue(k, 99999, 'a'), 800);   // ⛔ 不是外推出一个更大的数
  assert.strictEqual(mapValue(k, 1000, 'a'), 800);
});

test('mapValue_段内线性插值', () => {
  const k = buildKnots([{ a: 100, b: 50 }, { a: 400, b: 300 }], 1000, 800);
  // 首段 [0,100] → [0,50]
  assert.strictEqual(mapValue(k, 50, 'a'), 25);
  // 中段 [100,400] → [50,300]，斜率 250/300
  assert.strictEqual(mapValue(k, 250, 'a'), 175);
  // 尾段 [400,1000] → [300,800]
  assert.strictEqual(mapValue(k, 700, 'a'), 550);
});

test('mapValue_反向也要对', () => {
  const k = buildKnots([{ a: 100, b: 50 }, { a: 400, b: 300 }], 1000, 800);
  assert.strictEqual(mapValue(k, 175, 'b'), 250);
  assert.strictEqual(mapValue(k, 25, 'b'), 50);
  assert.strictEqual(mapValue(k, 99999, 'b'), 1000);
});

test('mapValue_往返是单调的_不会倒挂', () => {
  const k = buildKnots([{ a: 100, b: 50 }, { a: 400, b: 300 }], 1000, 800);
  let prev = -1;
  for (let v = 0; v <= 1000; v += 7) {
    const r = mapValue(k, v, 'a');
    assert.ok(r >= prev, 'v=' + v + ' 处映射倒挂了');
    assert.ok(r >= 0 && r <= 800, 'v=' + v + ' 处映射越界：' + r);
    prev = r;
  }
});

test('mapValue_非数输入回落到首点', () => {
  const k = buildKnots([{ a: 100, b: 50 }], 1000, 800);
  assert.strictEqual(mapValue(k, NaN, 'a'), 0);
  assert.strictEqual(mapValue(k, undefined, 'a'), 0);
  assert.strictEqual(mapValue(k, 'abc', 'a'), 0);
  assert.strictEqual(mapValue([], 5, 'a'), 0);
});

test('mapValue_单点折线恒等于那个点', () => {
  assert.strictEqual(mapValue([{ a: 0, b: 0 }], 123, 'a'), 0);
  assert.strictEqual(mapValue([{ a: 0, b: 0 }], 123, 'b'), 0);
});

test('guard_谁先动谁是源', () => {
  const g = createGuard('src', 'dst');
  assert.strictEqual(g.origin(), null);
  assert.strictEqual(g.accept('src', 10), true);
  assert.strictEqual(g.origin(), 'src');
});

test('guard_源栏连续事件都接受', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  assert.strictEqual(g.accept('src', 30), true);
  assert.strictEqual(g.accept('src', 300), true);
});

test('guard_程序写回的回声被丢掉', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 250);
  assert.strictEqual(g.accept('dst', 250), false);   // ⭐ 回声
  assert.strictEqual(g.origin(), 'src');             // ⚠️ 来源没被抢走
});

test('guard_容差内的回声也算回声', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 250);
  // 亚像素取整 / 缩放带来的 ±1px
  assert.strictEqual(g.accept('dst', 250.4), false);
  assert.strictEqual(g.accept('dst', 249), false);
  assert.strictEqual(g.origin(), 'src');
});

test('guard_延后到达的回声仍然被认出', () => {
  // ⚠️⚠️ 这是"⛔ 不能只用布尔锁"那一条的**直接回归**：
  //    连续写回 500 → 600 → 700 之后，**第一条**的回声才到。
  //    只记"最后一个值"的实现会在这里把 500 判成用户接管 ⇒ 来源乱跳。
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

test('guard_回声记得太多会被顶掉_但只顶最旧的', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  for (let i = 0; i < SY.ECHO_KEEP; i++) g.noteWrite('dst', 100 + i * 10);
  // 最近那一批都还在
  assert.strictEqual(g.accept('dst', 100 + (SY.ECHO_KEEP - 1) * 10), false);
  // ⚠️ 被顶掉的那个不再被认成回声 ⇒ 判成"用户接管"（保守方向，⛔ 不是死锁）
  assert.strictEqual(g.accept('dst', 5), true);
  assert.strictEqual(g.origin(), 'dst');
});

test('guard_非来源栏的值对不上就是用户接管', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 250);
  // 用户拖了预览栏的滚动条（不发 wheel、也不等于我们写进去的值）
  assert.strictEqual(g.accept('dst', 900), true);
  assert.strictEqual(g.origin(), 'dst');
  // ⭐ 移交之后，原来的源栏反过来变成被驱动方
  g.noteWrite('src', 40);
  assert.strictEqual(g.accept('src', 40), false);
  assert.strictEqual(g.origin(), 'dst');
});

test('guard_判据是相等_不是变化量阈值', () => {
  // ⚠️⚠️ 快速滚动时用户自己一动就是几百像素。
  //    任何"变化量够大才算用户滚动"的判据都会在这里把**真回声**放行 ⇒ 反弹。
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 5000);              // 一次巨大的写回
  assert.strictEqual(g.accept('dst', 5000), false);
  assert.strictEqual(g.origin(), 'src');
});

test('guard_显式移交立刻生效', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.setOrigin('dst');
  assert.strictEqual(g.origin(), 'dst');
  g.noteWrite('src', 42);
  assert.strictEqual(g.accept('src', 42), false);   // src 现在是被驱动方
});

test('guard_未知栏名一律不接受', () => {
  const g = createGuard('src', 'dst');
  assert.strictEqual(g.accept('窗口', 1), false);
  assert.strictEqual(g.accept(null, 1), false);
  g.setOrigin('窗口');
  assert.strictEqual(g.origin(), null);
});

test('guard_reset_清干净', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 250);
  g.reset();
  assert.strictEqual(g.origin(), null);
  // ⚠️ 清完之后 250 不再是"我写过的东西"⇒ 它成了一条普通的用户事件
  assert.strictEqual(g.accept('dst', 250), true);
  assert.strictEqual(g.origin(), 'dst');
});

test('guard_非数事件不会把自己判成回声', () => {
  const g = createGuard('src', 'dst');
  g.accept('src', 10);
  g.noteWrite('dst', 250);
  assert.strictEqual(g.accept('dst', NaN), true);   // ⛔ 不因为"比不出来"就丢掉真事件
  assert.strictEqual(g.origin(), 'dst');
});

// ═══════════════════════════════════════════════════════════════════════
// ⭐ **接线那半**（`createDriver`，`design/0012` §11.6/§11.7）
//
// ⚠️ 这一段用一个**最小的假 DOM**（只要 `scrollTop`/`scrollHeight`/`clientHeight`
//    与那三个事件方法）。理由见 `sync.js` 头部：接线的失效形态是
//    "两栏互相推 / 换了字号就偏了"，**屏幕上都没有异常信息**——
//    ⛔ 那不是"跑一下看看"能看出来的东西。
// ⚠️ 真的 `MutationObserver`/`ResizeObserver` 在 node 里不存在（`typeof` 判为假 ⇒
//    驱动会跳过它们）。那两个由**离屏探针**在真 WKWebView 里覆盖。
// ═══════════════════════════════════════════════════════════════════════

/** 一个够用的假滚动容器。⛔ 它**不自己派发** `scroll`——那正是"事件会迟到"的模型。 */
function fakeEl(o) {
  const el = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    _ev: Object.create(null),
    addEventListener: function (t, f) {
      // ⚠️ 按类型去重：真实 DOM 上同一个函数挂两次只会被调一次。
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

/** 手摇的 rAF：`schedule()` 排进去，`flush()` 才跑。 */
function fakeRaf() {
  let q = [];
  return {
    raf: function (fn) { q.push(fn); return q.length; },
    cancel: function () { /* ⚠️ 假实现：`stop()` 也靠 `running` 兜底，见下 */ },
    flush: function () { const a = q; q = []; for (let i = 0; i < a.length; i++) a[i](0); },
    pending: function () { return q.length; },
  };
}

/**
 * 一套标准的两栏 + 驱动。
 * ⚠️ 数字是**手算得出来**的：maxA 1500 / maxB 2000，两个锚点 0→0、100→400
 *    ⇒ 源码 `800` 恰好映射到预览 `1200`（段内比例 0.5）。
 */
function 搭一个(over) {
  const o = over || {};
  const srcEl = fakeEl({ scrollHeight: 2000, clientHeight: 500 });   // maxA = 1500
  const dstEl = fakeEl({ scrollHeight: 3000, clientHeight: 1000 });  // maxB = 2000
  const 时钟 = fakeRaf();
  const 布局钩子 = [];
  const st = { fresh: o.fresh !== false, src: srcEl, dst: dstEl };
  const drv = createDriver({
    src: function () { return st.src; },
    dst: function () { return st.dst; },
    lineTop: lineTop20,
    toc: function () { return [{ id: 'a', line: 1 }, { id: 'b', line: 6 }]; },  // 1→0、6→100
    headingTops: function () { return [{ id: 'a', top: 0 }, { id: 'b', top: 400 }]; },
    fresh: function () { return st.fresh; },
    onChange: function (cb) { 布局钩子.push(cb); return function () {}; },
    raf: 时钟.raf,
    cancelRaf: 时钟.cancel,
  });
  return { srcEl, dstEl, 时钟, 布局钩子, st, drv };
}

test('driver_起来就建有锚点的折线', () => {
  const t = 搭一个();
  t.drv.start();
  const s = t.drv.state();
  assert.strictEqual(s.running, true);
  assert.strictEqual(s.anchors, 2);
  assert.strictEqual(s.exact, true);
  // ⚠️ 是 **3** 不是 4：第一个锚点 `(0, 0)` 与补上去的端点重合 ⇒ 按"两轴严格递增"
  //    被丢掉（重合的那一条留着只会造出一个零长段）。
  assert.strictEqual(s.knots, 3);   // (0,0) + 锚点 (100,400) + (1500,2000)
});

test('driver_源码滚_预览按折线走', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 800;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 1200);
});

test('driver_程序写进去的那条回声被吞_不会反弹', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 800;
  t.srcEl.fire('scroll');                      // 驱动 ⇒ 写了 dst = 1200
  assert.strictEqual(t.dstEl.scrollTop, 1200);
  // ⭐ 浏览器**稍后**为那次赋值派一条 scroll。它必须被认成回声。
  const 写前的源 = t.srcEl.scrollTop;
  t.dstEl.fire('scroll');
  assert.strictEqual(t.srcEl.scrollTop, 写前的源, '回声把源码栏推动了 ⇒ 会来回抖');
  assert.strictEqual(t.drv.state().origin, SY.SRC, '来源被回声抢走了');
});

test('driver_连续驱动后迟到的旧回声仍被吞', () => {
  // ⚠️ 只用"最后一个值"记回声的实现会在这里判成用户接管 ⇒ 来源乱跳。
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 300; t.srcEl.fire('scroll');
  const 甲 = t.dstEl.scrollTop;
  t.srcEl.scrollTop = 800; t.srcEl.fire('scroll');
  const 乙 = t.dstEl.scrollTop;
  t.srcEl.scrollTop = 1500; t.srcEl.fire('scroll');
  assert.notStrictEqual(甲, 乙);
  // 迟到的那批按**倒序**到达
  t.dstEl.scrollTop = 甲; t.dstEl.fire('scroll');
  t.dstEl.scrollTop = 乙; t.dstEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
});

test('driver_另一栏自己滚_及时移交', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 800; t.srcEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
  // 用户拖预览栏的滚动条（不发 wheel、值也不等于我们写的）
  t.dstEl.scrollTop = 1900;
  t.dstEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.DST);
  // ⭐ 移交给它之后，源码栏反过来被驱动
  assert.notStrictEqual(t.srcEl.scrollTop, 800);
});

test('driver_碰一下哪一栏就立刻移交', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 800; t.srcEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
  t.dstEl.fire('wheel');
  assert.strictEqual(t.drv.state().origin, SY.DST);
  t.srcEl.fire('pointerdown');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
});

test('driver_结果一律夹进可滚范围', () => {
  const t = 搭一个();
  // 预览根本不可滚 ⇒ 上界 0 ⇒ 不管源码滚到哪儿，预览都只能是 0
  t.dstEl.scrollHeight = 1000;
  t.dstEl.clientHeight = 1000;
  t.drv.start();
  t.srcEl.scrollTop = 1500;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 0);
});

test('driver_写进去的必须是夹取之后的值_否则回声对不上', () => {
  // ⚠️⚠️ 这一条守的是一个**很隐蔽**的反馈环：若把**未夹取**的值记进回声、
  //    却让浏览器把 `scrollTop` 夹小，那么随后那条事件的值与记录不等
  //    ⇒ 被判成"用户接管" ⇒ 来源翻转，下一帧又反过来推 ⇒ 抖。
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 1500;               // 映射到 2000（正好是上界）
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 2000);
  // 让预览变矮：上界从 2000 掉到 500
  t.dstEl.scrollHeight = 1500;
  t.srcEl.scrollTop = 1500;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 500);
  t.dstEl.fire('scroll');                 // 回声
  assert.strictEqual(t.drv.state().origin, SY.SRC, '夹取没记账 ⇒ 回声没认出来');
});

test('driver_预览落后于源码时降级成按比例', () => {
  const t = 搭一个();
  t.drv.start();
  assert.strictEqual(t.drv.state().exact, true);
  // ⭐ §11.7：「预览落后于源码时，不得把旧行号映射当作当前精确位置使用」
  t.st.fresh = false;
  t.drv.rebuild();
  const s = t.drv.state();
  assert.strictEqual(s.exact, false);
  assert.strictEqual(s.anchors, 0);
  assert.strictEqual(s.knots, 2);          // 只剩两端点
  // 按比例：750/1500 → 1000/2000
  t.srcEl.scrollTop = 750;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 1000);
});

test('driver_预览提交后精确性回来', () => {
  const t = 搭一个();
  t.drv.start();
  t.st.fresh = false;
  t.drv.rebuild();
  assert.strictEqual(t.drv.state().exact, false);
  t.st.fresh = true;                       // = `renderPreviewOnce` 提交完
  t.drv.rebuild();
  assert.strictEqual(t.drv.state().exact, true);
  t.srcEl.scrollTop = 800;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 1200);   // 锚点那一段，不是按比例
});

test('driver_布局变化走合流_一次 flush 只重建一次', () => {
  const t = 搭一个();
  t.drv.start();
  // 观察器看不见的那几种（字号 / 分栏宽 / 窗口尺寸）由 `onChange` 转告
  assert.strictEqual(t.布局钩子.length, 1);
  t.布局钩子[0]();
  t.布局钩子[0]();
  t.布局钩子[0]();
  assert.strictEqual(t.时钟.pending(), 1, '三次通知排了不止一个回调');
  t.dstEl.scrollHeight = 4000;             // 上界 2000 → 3000
  t.时钟.flush();
  t.srcEl.scrollTop = 1500;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 3000, '折线没跟着新上界重建');
});

test('driver_拆卸后监听全撤_迟到的一律无效', () => {
  const t = 搭一个();
  t.drv.start();
  t.布局钩子[0]();
  assert.strictEqual(t.时钟.pending(), 1);
  t.drv.stop();
  // ⚠️⚠️ 这一条是"旧请求、旧 DOM 的映射不得继续使用"那一条的落点：
  //    已经排进 rAF 的回调必须**作废**，⛔ 不能拿它去重建一个已经拆掉的会话。
  t.时钟.flush();
  assert.strictEqual(t.srcEl.listenerCount(), 0);
  assert.strictEqual(t.dstEl.listenerCount(), 0);
  const s = t.drv.state();
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.knots, 0);
  assert.strictEqual(s.origin, null);
});

test('driver_拆卸之后再滚什么都不会发生', () => {
  const t = 搭一个();
  t.drv.start();
  t.drv.stop();
  t.srcEl.scrollTop = 900;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 0);
});

test('driver_重复_start_不重复挂监听', () => {
  const t = 搭一个();
  t.drv.start();
  const n = t.srcEl.listenerCount();
  t.drv.start();
  assert.strictEqual(t.srcEl.listenerCount(), n);
});

test('driver_重新_start_把来源闸清干净', () => {
  const t = 搭一个();
  t.drv.start();
  t.srcEl.scrollTop = 800; t.srcEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.SRC);
  t.drv.stop();
  t.drv.start();
  assert.strictEqual(t.drv.state().origin, null, '来源跨会话留了下来');
  t.dstEl.scrollTop = 1700;                // 值也陈旧地留在回声表里的话，这条会被吞
  t.dstEl.fire('scroll');
  assert.strictEqual(t.drv.state().origin, SY.DST);
});

test('driver_容器换了就驱动新容器', () => {
  // ⚠️ 预览重渲**不换** `#doc` 这个元素，但换文档/重建会；取值器每帧现取是为这个。
  const t = 搭一个();
  t.drv.start();
  const 新 = fakeEl({ scrollHeight: 3000, clientHeight: 1000 });
  t.st.dst = 新;
  t.srcEl.scrollTop = 800;
  t.srcEl.fire('scroll');
  assert.strictEqual(新.scrollTop, 1200);
  assert.strictEqual(t.dstEl.scrollTop, 0, '写到了已经不在用的那个元素上');
});

test('driver_容器还拿不到时_start_不半死', () => {
  const t = 搭一个();
  t.st.src = null;
  t.drv.start();
  assert.strictEqual(t.drv.state().running, false);
  // ⚠️ 不能留下"挂了一半的事件"——那会在容器真的出现之后变成两条驱动
  assert.strictEqual(t.dstEl.listenerCount(), 0);
  t.st.src = t.srcEl;
  t.drv.start();
  assert.strictEqual(t.drv.state().running, true);
  t.srcEl.scrollTop = 800;
  t.srcEl.fire('scroll');
  assert.strictEqual(t.dstEl.scrollTop, 1200);
});

test('driver_没有标题的文档照样工作', () => {
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
  assert.strictEqual(drv.state().used, 0);
  // ⭐ 它不是"没有映射"，是**按比例**——那仍是能给出的最好的答案
  srcEl.scrollTop = 750;
  srcEl.fire('scroll');
  assert.strictEqual(dstEl.scrollTop, 1000);
});

// ═══════════════════════════════════════════════════════════════════════
// ⭐ **采集到的锚点 ≠ 折线里用上的锚点**（`design/0012` §11.7）
//
// ⚠️⚠️ 这一族是**汇报会说谎**的那一类：`buildKnots` 会把**触到任一边界**的锚点
//    整条丢掉（`p.a >= A || p.b >= B`），某一栏**不可滚**时更是**每一条都丢**
//    （`maxB = 0` ⇒ `p.b <= last.b` 恒成立）⇒ 折线只剩 `(0,0)` 一个点。
//    ⇒ 拿"采集数"当精确性，`make smoke` 那一行会印成
//      「精确｜锚点 7｜折线 1」——**一句谎**，而那一行是给人工看的唯一入口。
//    ⭐ 所以两个数**分开报**（`anchors` / `used`），`exact` 判的是**后者**。
// ═══════════════════════════════════════════════════════════════════════

test('driver_预览栏不可滚_用上的锚点是0_而不是采集数', () => {
  const 时钟 = fakeRaf();
  const srcEl = fakeEl({ scrollHeight: 2000, clientHeight: 500 });   // maxA = 1500
  const dstEl = fakeEl({ scrollHeight: 800, clientHeight: 800 });    // maxB = 0（不可滚）
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
  // ⚠️ 锚点**配上了**（采集 2 条）——右表有这两个 id，行号也换得出来
  assert.strictEqual(s.anchors, 2);
  // ⭐ 但它们**一条都进不了折线**：`maxB = 0` ⇒ 全被丢
  assert.strictEqual(s.used, 0);
  assert.strictEqual(s.knots, 1);
  // ⭐⭐ 关键：这时**必须**说"按比例"。说"精确"就是那句谎。
  assert.strictEqual(s.exact, false);
  // ⚠️ 而且映射真的退了：预览栏不动（它没得动），源码栏也不该被推
  srcEl.scrollTop = 800;
  srcEl.fire('scroll');
  assert.strictEqual(dstEl.scrollTop, 0);
  assert.strictEqual(srcEl.scrollTop, 800, '回声把源码栏推动了');
});

test('driver_源码栏不可滚_同理', () => {
  const 时钟 = fakeRaf();
  const srcEl = fakeEl({ scrollHeight: 500, clientHeight: 500 });    // maxA = 0
  const dstEl = fakeEl({ scrollHeight: 3000, clientHeight: 1000 });  // maxB = 2000
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

test('driver_用上的锚点数_要减掉补上去的两个端点', () => {
  // ⚠️ 夹具同一套：两个锚点里 `(0,0)` 与补的起点重合被丢、`(100,400)` 留下
  //    ⇒ 折线 3 点，**用上 1 个**。⛔ 写成 `knots.length - 2` 在同一套夹具上
  //    会算出 1（碰巧对），但末尾补点在"某一轴没余量"时不补 ⇒ 那个算式会**多减一个**。
  const t = 搭一个();
  t.drv.start();
  const s = t.drv.state();
  assert.strictEqual(s.knots, 3);
  assert.strictEqual(s.used, 1);
  assert.strictEqual(s.anchors, 2);
  assert.strictEqual(s.exact, true);
});

test('driver_用上的锚点数_与折线点数的关系', () => {
  // ⭐ 两栏**都**滚得动时，尾点 `(A,B)` **必定**被补上（`A > last.a` 与 `B > last.b`
  //    在"锚点严格小于 A/B"这条不变量下恒成立）⇒ `knots = used + 2`。
  // ⚠️ 但**退化那一支**（某一轴没余量）里 `knots = 1`，`knots - 2` 会算成 **-1**。
  //    那正是"数法"必须数**点**、⛔ 不数差值的理由——上面两条已经钉了退化那一支。
  const t = 搭一个();
  t.drv.start();
  assert.strictEqual(t.drv.state().knots, t.drv.state().used + 2);

  const 时钟 = fakeRaf();
  const srcEl = fakeEl({ scrollHeight: 2000, clientHeight: 500 });   // maxA = 1500
  const dstEl = fakeEl({ scrollHeight: 2000, clientHeight: 1000 });  // maxB = 1000
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
  // `(0,0)` 与补的起点重合被丢；`(100,400)` 留下；尾点 `(1500,1000)` 补上
  assert.strictEqual(s.anchors, 2);
  assert.strictEqual(s.used, 1);
  assert.strictEqual(s.knots, 3);
  assert.strictEqual(s.exact, true);
});

// ═══════════════════════════════════════════════════════════════════════
// ⭐ **行 → 像素**那一步（`sourceLineTopOf`，`design/0012` §11.3 第 2 步）
//
// ⚠️ 它是 §11 里**唯一押在 CM6 行为上**的假设（`lineBlockAt` 给的是**内容坐标**，
//    与 `scrollTop` 同一把尺子）。真 CM6 那半由离屏探针验；这里只钉
//    "拿不到位置时**必须是 `null`**"——⛔ 补 0 会让一个不存在的行
//    变成"在第 0 像素"，而那个数会**静默地**拉直一整段折线。
// ═══════════════════════════════════════════════════════════════════════

/** 一个最小的假 CM6 视图：行高恒定 20，`lineBlockAt` 返回内容坐标。 */
function fakeView(lines, over) {
  const v = {
    state: {
      doc: {
        lines: lines,
        line: function (n) { return { from: (n - 1) * 5 }; },   // 每行 5 个字符，无所谓
      },
    },
    lineBlockAt: function (from) { return { top: (from / 5) * 20 }; },
  };
  if (over) for (const k in over) v[k] = over[k];
  return v;
}

test('lineTop_行号换成内容坐标', () => {
  const v = fakeView(10);
  assert.strictEqual(SY.sourceLineTopOf(v, 1), 0);
  assert.strictEqual(SY.sourceLineTopOf(v, 4), 60);
});

test('lineTop_越界一行都不给', () => {
  const v = fakeView(10);
  assert.strictEqual(SY.sourceLineTopOf(v, 0), null);
  assert.strictEqual(SY.sourceLineTopOf(v, -3), null);
  assert.strictEqual(SY.sourceLineTopOf(v, 11), null);
});

test('lineTop_非数行号不给', () => {
  const v = fakeView(10);
  assert.strictEqual(SY.sourceLineTopOf(v, NaN), null);
  assert.strictEqual(SY.sourceLineTopOf(v, undefined), null);
  assert.strictEqual(SY.sourceLineTopOf(v, '3'), null);
});

test('lineTop_小数行号向下取整', () => {
  assert.strictEqual(SY.sourceLineTopOf(fakeView(10), 4.7), 60);
});

test('lineTop_视图缺件时不给_而不是抛', () => {
  assert.strictEqual(SY.sourceLineTopOf(null, 1), null);
  assert.strictEqual(SY.sourceLineTopOf({}, 1), null);
  assert.strictEqual(SY.sourceLineTopOf({ state: {} }, 1), null);
  // ⚠️ `lineBlockAt` 不在导出面上（`design/0012` §2.1① 那张封闭清单）⇒ 结果也得是 null
  assert.strictEqual(SY.sourceLineTopOf({ state: { doc: { lines: 3 } } }, 1), null);
});

test('lineTop_lineBlockAt_抛或给怪值都不补零', () => {
  assert.strictEqual(SY.sourceLineTopOf(fakeView(5, {
    lineBlockAt: function () { throw new Error('视图已拆'); },
  }), 2), null);
  assert.strictEqual(SY.sourceLineTopOf(fakeView(5, {
    lineBlockAt: function () { return null; },
  }), 2), null);
  assert.strictEqual(SY.sourceLineTopOf(fakeView(5, {
    lineBlockAt: function () { return { top: NaN }; },
  }), 2), null);
});

// ═══════════════════════════════════════════════════════════════════════
// ⭐⭐ **接线那半的最后一跳**：`src/main.js` 真的把 driver 接上了吗
//      （`design/0012` §11.6，⭐ 源码级闸门 —— `docs/bugs/0004` 同族）
// ═══════════════════════════════════════════════════════════════════════
//
// ⚠️⚠️ **这一条守的是"谁也没在看"的那一段**（`docs/bugs/0004` 的形态）：
//     · 上面 62 条验的是 `sync.js` **自己**（直接 `createDriver(...)`）；
//     · `make probe-scroll-sync` 那 17 条验的也是**同一个东西**——
//       那个探针**自己**按 §11.6 的签名把 `createDriver` 接起来（见
//       `tools/wkwebview-probe/scroll-sync-harness.js`）。
//     ⇒ **两边都看不见产品里那一跳**：`src/main.js` 有没有真的调它、
//       有没有把**七个取值器**都递进去、右栏那个容器有没有走 `scrollHost()`。
//     ⚠️ 这一跳断了的表现**逐字等于用户的报障原话**——「编辑页面和展示页面，
//       滑动的时候，不同步。」而 `make test` 全绿、探针 17/17 绿、
//       屏幕上没有任何异常（连一个 console 错误都没有）：
//       `syncDriver` 是 `null`，`syncStart()` 静悄悄地什么都没做。
//
// ⚠️ `src/main.js` 是**根脚本**，在 node 里跑不起来（`require` 会执行它）
//    ⇒ 只能按**源码级闸门**写（同族先例：`editor.test.js` 的 `markEdited`
//    那条、`keymap.test.js` 的「脚本加载顺序·依赖先于取值」）。

/**
 * ⭐ **裸判据**：把 `src/main.js` 里某个函数的**函数体**抠出来。
 *
 * ⚠️ 为什么要抠身体而不是满篇 `grep`：`syncStart(` 这三个字在文件里
 *    **多处**出现（定义处、注释里、`syncStop` 挨着的地方）——
 *    一句 `code.includes('syncStart(')` **恒为真**，那样这条闸门等于不存在。
 *    必须问"**在哪个函数里**调用的"。
 * ⚠️ 按**花括号配平**切，⛔ 不按"到下一个 `function` 为止"——后者遇到
 *    函数里嵌套一个函数就切错，而它错的方向是**多切**（把别人的调用算进来 ⇒ 漏放）。
 * ⛔ 它**不是**解析器：不认字符串里的 `{`/`}`、也不认正则字面量。
 *    够用即可——真被这类形态骗到时它会**偏保守地报红**（逼人来看一眼），
 *    而不会**漏放**，那是安全的方向。
 */
function 身体(code, 名) {
  const 头 = new RegExp('(?:async\\s+)?function\\s+' + 名 + '\\s*\\(');
  const m = 头.exec(code);
  if (!m) return null;
  const 开 = code.indexOf('{', m.index);
  if (开 < 0) return null;
  let 深 = 0;
  for (let i = 开; i < code.length; i++) {
    if (code[i] === '{') 深++;
    else if (code[i] === '}') { 深--; if (深 === 0) return code.slice(开, i + 1); }
  }
  return null;   // 配不平 ⇒ 当作没抠到（⛔ 不假装成功）
}

/** 剥注释（行 ＋ 块）。⚠️ 见 `editor.test.js` 那条同样的说明。 */
function 去注释(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

test('⭐⭐ 接线（源码级）：`src/main.js` 真的建了 driver、七个取值器都递了', () => {
  const raw = require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  const code = 去注释(raw);

  const 起 = 身体(code, 'syncStart');
  assert.ok(起, '⛔ 在 `src/main.js` 里抠不出 `syncStart` 的函数体（改名了？）');

  assert.ok(
    /SY\s*\.\s*createDriver\s*\(/.test(起),
    '⛔ `syncStart` 里没有调 `SY.createDriver(...)` —— 左右滚动同步会**彻底失效**，' +
    '而屏幕上一点异常都没有（`syncDriver` 恒为 null）'
  );

  // ⭐ **七个取值器逐个点名**。⚠️ 少了任何一个的失败形态各不相同：
  //    `src`/`dst`    ⇒ 不驱动（或驱动错元素，见下一条）；
  //    `lineTop`      ⇒ 一个锚点都配不上 ⇒ 退化成按比例；
  //    `toc`          ⇒ 同上（源码侧行号没有来源）；
  //    `headingTops`  ⇒ 同上（预览侧像素没有来源）；
  //    `fresh`        ⇒ §11.7 那一条**整条消失**——预览落后时拿旧行号当精确位置；
  //    `onChange`     ⇒ 改字号 / 内容宽 / 行高 / 拖分栏之后**同步就偏了**，
  //                     而 `ResizeObserver` 那两条**一次都不会响**（§11.6 明写）。
  const 取值器 = ['src', 'dst', 'lineTop', 'toc', 'headingTops', 'fresh', 'onChange'];
  for (const k of 取值器) {
    assert.ok(
      new RegExp('\\b' + k + '\\s*:').test(起),
      '⛔ `createDriver` 少递了取值器 `' + k + ':` —— 见 `design/0012` §11.6 那张表'
    );
  }
});

test('⭐⭐ 接线（源码级）：预览栏的容器**必须经 `scrollHost()`**（§11.6 抄一份就是缺陷）', () => {
  const code = 去注释(require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8'));

  const 体 = 身体(code, 'syncDstElement');
  assert.ok(体, '⛔ 在 `src/main.js` 里抠不出 `syncDstElement` 的函数体');

  // ⚠️⚠️ 这一条是**具体一次实施期修正**的回归（2026-10-16）：
  //    初版写的是 `return editing ? $('doc') : null;` —— 那就等于把
  //    「右栏的滚动容器是谁」**又判了一遍**，而它在这个前端**只能有一处判定**
  //    （`scrollHost()`）。⚠️ 抄一份的失败形态是**静默的**：两边哪天不一致
  //    （比如编辑态改用别的最外层容器），同步就会去驱动一个看不见的元素。
  assert.ok(
    /scrollHost\s*\(/.test(体),
    '⛔ `syncDstElement` 没走 `scrollHost()` —— 它自己写了一份容器判定，' +
    '`design/0012` §11.6 的「⛔ 抄一份就是缺陷」当场被违反'
  );
  // ⚠️ 反面：不许直接把 `#doc` 写进去（那正是初版那一句的形态）。
  assert.ok(
    !/\$\s*\(\s*['"]doc['"]\s*\)/.test(体),
    '⛔ `syncDstElement` 里直接取了 `$(\'doc\')` —— 回到"抄一份"的老路上了'
  );
});

test('⭐⭐ 接线（源码级）：进出编辑态**各自**挂 / 拆（§11.6）', () => {
  const code = 去注释(require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8'));

  const 进 = 身体(code, 'enterEdit');
  const 出 = 身体(code, 'exitEdit');
  assert.ok(进 && 出, '⛔ 抠不出 `enterEdit` / `exitEdit` 的函数体');

  assert.ok(
    /\bsyncStart\s*\(\s*\)/.test(进),
    '⛔ `enterEdit` 里没有调 `syncStart()` —— 进编辑态**永远不会开始同步**'
  );
  assert.ok(
    /\bsyncStop\s*\(\s*\)/.test(出),
    '⛔ `exitEdit` 里没有调 `syncStop()` —— 退出编辑态后监听与观察器**留在原地**，' +
    '驱动一个已经拆掉的 CM6 视图（§11.6：每次进编辑态都是**新建**一个 driver）'
  );
});

// ═══════════════════════════════════════════════════════════════════════
// ⭐⭐ **提交那一刻的接线**：预览重渲之后，位置与 `toc` 怎么回去
//      （`docs/bugs/0006`，`design/0012` §2.6-5 / §10.14）
// ═══════════════════════════════════════════════════════════════════════
//
// ⚠️⚠️ 上面那 63 条与探针那 17 条**都碰不到这一段**：它们验的是"两栏之间怎么跟"，
//    而这里问的是"**整棵 DOM 被换掉的那一刻**，位置与行号有没有跟着一起换"。
//    ⇒ 用户报障的原话是「在输入状态下，页面会上下晃动，感觉是在滚动。」
//    ⚠️ 而它同样是**静默**的：`make test` 全绿、探针 17/17 绿、一个 console 错误都没有。
//
// ⭐ 三件事各有一条闸门（逐条对应 `docs/bugs/0006` §3 的三个根因）：
//    ① 记的是**三级锚点**，⛔ 不是裸 `scrollTop`；
//    ② 这次写**必须经来源闸记账**（`hostSetTop` → `写入预览`），⛔ 不是裸赋值；
//    ③ 挂上去的 `toc` **必须同时是"位置的那一份"**（预览提交不碰会话状态）。

/** ⭐ 裸判据：某段源码里有没有"对 `doc` / 宿主的裸赋值"。供测试自己拿假源码问它。 */
function 有裸写滚动(code) {
  return /(?:^|[^.\w])[A-Za-z_$][\w$]*(?:\s*\.\s*scrollTop)\s*=(?!=)/.test(code);
}

test('⭐⭐ 提交接线：`mountDocument` 记的是**三级锚点**（⛔ 不是裸 `scrollTop`）', () => {
  const code = 去注释(require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8'));
  const 体 = 身体(code, 'mountDocument');
  assert.ok(体, '⛔ 在 `src/main.js` 里抠不出 `mountDocument` 的函数体（改名了？）');

  // ⭐ 必须用 §6.1 那一份锚点实现（`reload.js`），⛔ 不另写一份。
  assert.ok(
    /captureAnchor\s*\(/.test(体) && /resolveAnchor\s*\(/.test(体),
    '⛔ `mountDocument` 的 `keepScroll` 分支没走三级锚点（`captureAnchor` / `resolveAnchor`）' +
    ' —— 裸 `scrollTop` 在不均等的重排下不指向同一处内容：实测文末一次提交挪 **48 px**，' +
    '而锚点法是 0（`docs/bugs/0006`）'
  );
  // ⭐ 还回去那一笔必须走唯一的写入口（`hostSetTop`）。
  assert.ok(
    /hostSetTop\s*\(/.test(体),
    '⛔ `mountDocument` 自己写了滚动位置 —— 绕过 `hostSetTop`，同步的来源闸不会记账'
  );
  // ⚠️ 反面：⛔ 不许直接写 `doc.scrollTop = …`（那正是修掉之前的产品原样）。
  assert.ok(
    !有裸写滚动(体),
    '⛔ `mountDocument` 里仍然有对宿主的裸 `scrollTop` 赋值 —— 那次写会被来源闸' +
    '判成"用户接管预览栏"，于是它立刻反向驱动源码栏（`docs/bugs/0006`）'
  );
  // ⚠️ 裸判据自己也要过一遍（否则上面那条可能是"正则写错 ⇒ 恒为假"）。
  assert.ok(有裸写滚动('  doc.scrollTop = y;'), '⛔ 裸判据漏了最直白的那种形态');
  assert.ok(!有裸写滚动('  doc.scrollTop === y;'), '⛔ 裸判据把比较当成了赋值');
  assert.ok(!有裸写滚动('  if (a = 1) {}'), '⚠️ 顺带：`a = 1` 不是滚动位置，不该命中');
});

test('⭐⭐ 提交接线：**唯一的写入口**必须把这次写记成回声（`写入预览`）', () => {
  const code = 去注释(require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8'));
  const 体 = 身体(code, 'hostSetTop');
  assert.ok(体, '⛔ 在 `src/main.js` 里抠不出 `hostSetTop` 的函数体');

  assert.ok(
    /写入预览\s*\(/.test(体),
    '⛔ `hostSetTop` 没有把这次写交给 driver 记账（`syncDriver.写入预览`）—— ' +
    '程序滚动与用户滚动的 `scroll` 事件长得一模一样，来源闸只能靠"值是不是我刚写的"分辨' +
    '（`sync.js` 的期望值回显环）：不记账就会被当成用户接管 ⇒ 两栏互推 ⇒ 抖'
  );
  // ⚠️ 但**必须留回落**：没有 driver 时（阅读态 / driver 已停）也要能写。
  assert.ok(
    /\.scrollTop\s*=/.test(体) || /scrollTo\s*\(/.test(体),
    '⛔ `hostSetTop` 在没有 driver 时没有回落路径 —— 阅读态的滚动恢复会整个失效'
  );
  // ⭐ 而且回落那一次**只该在"没有 driver"时发生**：判据是 driver 的分支在它**前面**。
  const 记 = 体.indexOf('写入预览');
  const 裸 = Math.max(体.lastIndexOf('.scrollTop ='), 体.lastIndexOf('scrollTo('));
  assert.ok(记 >= 0 && 裸 > 记, '⛔ 裸赋值的回落必须排在记账那一支**之后**（否则永远走不到记账）');
});

test('⭐⭐ 提交接线：挂完 DOM 之后，`toc` 必须换成**这一份渲染的**（§11.7）', () => {
  const code = 去注释(require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8'));
  const 体 = 身体(code, 'mountDocument');
  assert.ok(体, '⛔ 抠不出 `mountDocument` 的函数体');

  // ⚠️ 预览提交**刻意不碰会话状态**（`INV-EDIT-07`）⇒ 不换 `toc` 的话，
  //    `headingPositions()` 与折线拿的都是**上一版文本**的行号，而 DOM 已经是这一版的了。
  //    ⭐ 后果静默：`syncState()` 照旧报「精确」。实测 6 次回车 ⇒ 映射偏 **377 px**（`bugs/0006`）。
  assert.ok(
    /S\s*\.\s*state\s*\.\s*currentDoc\s*\.\s*toc\s*=/.test(体),
    '⛔ `mountDocument` 没有把 `payload.toc` 写回 `S.state.currentDoc.toc` —— ' +
    '折线与 `headingPositions()` 会用上一版的行号，而 `滚动同步：` 那一行照旧印「精确」'
  );
  // ⚠️ 顺序：必须排在同一函数里那句 `setToc` 的**旁边**（⛔ 别挪到别处去当"顺手一提"）。
  assert.ok(
    体.indexOf('setToc') >= 0 && 体.indexOf('currentDoc.toc') > 体.indexOf('setToc'),
    '⚠️ `currentDoc.toc` 的赋值应当紧跟在 `sidebar.setToc(payload.toc)` 之后（同一批、同一处）'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ⭐ `design/0019` §2.2：**产品侧**的嵌套闸门（T19-1）
//
// # 它补的那个窟窿
//
// `make probe-edit-chrome` 的判据 `#22`（「`#preview-bar` 仍在 `.topbar` 内且贴下沿」）
// 量的是**探针自己就地拼的那份标记**——探针**不加载** `src/index.html`
// （`tools/wkwebview-probe/edit-chrome-harness.js` 手拼 DOM ＋ 注入 CSS/JS）。
// ⇒ 产品侧哪天把提示条挪出 `.topbar`，探针**照样全绿**，而屏幕上的表现是
// 「编辑态提示条可能被某一栏裁剪 / 位置漂移」——**没有报错**。
//
// # 为什么不改探针
//
// 让它加载真页面要重验那 23 条判据的**全部前提**（真页面启动要走 Tauri IPC 与引导流程）
// ⇒ 为一条判据重写整个夹具，风险远大于收益（`design/0019` §2.1 路 ②）。
// ⇒ 选**源码级闸门**（同 `keymap.test.js` 的 `<script>` 顺序闸门、同 `docs/bugs/0006`
//    那三条"产品源码里的一跳"）。
//
// ⚠️ `INV-GATE-01`：读的是**产品**那份 `src/index.html`，⛔ 不是夹具或复制品。
// ⚠️ `INV-GATE-02`：**先剥注释再判**——这个文件的注释里**真的**写着
//    「⚠️ 它在 `.topbar` **里面**」。不剥的话，闸门会被那句**注释**喂饱。
// ⚠️ `INV-GATE-03`：形状有歧义（目标 0 次 / ≥ 2 次）⇒ **判红**，⛔ 不猜。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 把 HTML 注释**挖成空格**（保留换行）。
 * ⚠️ 与 `keymap.test.js::stripComments` 的 HTML 那半**同语义**（那份没导出，
 * 且它还管 JS 注释）；这里是最小版本，**由夹具第 4 格自测**。
 */
function 剥HTML注释(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

/** 取一个属性的值（单/双引号或裸值）；没有就是 `null`。 */
function 取属性(attrs, 名) {
  const m = new RegExp('(?:^|\\s)' + 名 + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))').exec(attrs);
  if (!m) return null;
  return m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
}

/** void 元素**不压栈**（它们没有闭合标签）。⚠️ 漏一个就会让整棵栈错位。 */
const VOID_TAGS = new Set(['meta', 'link', 'br', 'img', 'input', 'hr',
  'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

/**
 * 量一次：目标 id 出现几次、带该 class 的容器有几个、目标是不是容器**的后代**。
 *
 * ⚠️ 它**不是**解析器：不认 `<script>` 里的字符串、也不认 CDATA。
 *    够用即可——被这类形态骗到时它会**偏保守**（数出来的次数不对 ⇒ 判红），
 *    而 ⛔ 不会**假绿**，那是安全的方向。
 */
function 量(html, 目标id, 容器类名) {
  const s = 剥HTML注释(html);
  const re = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const 栈 = [];            // [{ 名, 是容器 }]
  let 目标数 = 0;
  let 容器数 = 0;
  let 在内 = false;
  let m;
  while ((m = re.exec(s))) {
    const 闭 = m[1] === '/';
    const 名 = m[2].toLowerCase();
    const 属性 = m[3] || '';
    if (闭) {
      // 弹到最近一个同名开标签（容错：找不到就什么都不做，⛔ 不把栈掏空）
      for (let i = 栈.length - 1; i >= 0; i--) {
        if (栈[i].名 === 名) { 栈.length = i; break; }
      }
      continue;
    }
    const idv = 取属性(属性, 'id');
    const cls = 取属性(属性, 'class');
    const 是容器 = 容器类名 != null && cls != null &&
      cls.split(/\s+/).indexOf(容器类名) >= 0;
    if (是容器) 容器数 += 1;
    if (idv === 目标id) {
      目标数 += 1;
      // ⚠️ 只在**唯一**那一次命中时取值；否则由调用方按 `目标数 !== 1` 判红。
      在内 = 栈.some(function (e) { return e.是容器; });
    }
    if (!VOID_TAGS.has(名) && !/\/\s*$/.test(属性)) {
      栈.push({ 名: 名, 是容器: 是容器 });
    }
  }
  return { 目标数: 目标数, 容器数: 容器数, 在内: 在内 };
}

/**
 * ⭐ **裸判据**（同 `docs/bugs/0006` 那三条的写法：可被测试拿**假源码**直接问）。
 * 它只答一句话：目标元素是不是某个 class 容器的**后代**。
 * ⚠️ 出现次数 ≠ 1 ⇒ 一律 `false`（有歧义时⛔ 不许猜，`INV-GATE-03`）。
 */
function 在容器内(html, 目标id, 容器类名) {
  const r = 量(html, 目标id, 容器类名);
  return r.目标数 === 1 && r.在内 === true;
}

test('⭐⭐ 产品侧嵌套：`#preview-bar` 真的在 `.topbar` 之内（`design/0019` §2.2）', () => {
  // ── 一、**裸判据自测**（四种夹具）──────────────────────────────────────
  // ⚠️ 这一段**必须排在读真文件之前**：裸判据自己不对的话，下面那条绿毫无意义。
  assert.equal(
    在容器内('<div class="topbar"><div id="preview-bar"></div></div>', 'preview-bar', 'topbar'),
    true,
    '正例（直接子元素）判错了 —— 裸判据本身就不成立'
  );
  assert.equal(
    在容器内('<div class="topbar"></div><div id="preview-bar"></div>', 'preview-bar', 'topbar'),
    false,
    '⛔ **兄弟**被当成了后代 —— 这正是产品出错时的形态，判据必须红'
  );
  assert.equal(
    在容器内('<div class="topbar"><div><div id="preview-bar"></div></div></div>', 'preview-bar', 'topbar'),
    true,
    '⛔ 孙代没算成后代 —— "后代"⛔ 不是"直接子元素"（真页面里就隔着好几层）'
  );
  assert.equal(
    在容器内('<!-- <div class="topbar"><div id="preview-bar"></div></div> --><div id="preview-bar"></div>',
      'preview-bar', 'topbar'),
    false,
    '⛔ **注释里的提及**让闸门变绿了 —— `INV-GATE-02` 要求先剥注释再判'
  );
  // ⚠️ 再补两格：歧义必须判红（`INV-GATE-03`），以及 class 里的 token 必须是整词。
  assert.equal(
    在容器内('<div class="topbar"><div id="preview-bar"></div><div id="preview-bar"></div></div>',
      'preview-bar', 'topbar'),
    false,
    '⛔ 目标出现两次却给了答案 —— 形状有歧义时必须判红'
  );
  assert.equal(
    在容器内('<div class="topbar-x"><div id="preview-bar"></div></div>', 'preview-bar', 'topbar'),
    false,
    '⛔ `topbar-x` 被当成了 `topbar` —— class 必须按**整词**比，⛔ 不是子串'
  );

  // ── 二、对**产品源码**的断言（`INV-GATE-01`）────────────────────────────
  const html = require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

  const r = 量(html, 'preview-bar', 'topbar');
  assert.equal(
    r.目标数, 1,
    '⛔ `src/index.html` 里 `id="preview-bar"` 出现了 ' + r.目标数 + ' 次（必须恰好 1 次）——' +
    '0 次 = 提示条被删了；≥2 次 = 复制出了第二个，浏览器只认第一个、行为不确定'
  );
  assert.equal(
    r.容器数, 1,
    '⛔ `class` 含 `topbar` 的元素有 ' + r.容器数 + ' 个（必须恰好 1 个）——' +
    '否则"后代"这个词可能指错对象'
  );
  assert.ok(
    在容器内(html, 'preview-bar', 'topbar'),
    '⛔ `#preview-bar` **不在** `.topbar` 之内（或形状有歧义）——' +
    '`edit-chrome-probe` 会**照样全绿**（它量的是自己拼的那份标记），' +
    '而编辑态提示条的位置/裁剪会静默坏掉。见 `design/0019` §1.1'
  );
});
