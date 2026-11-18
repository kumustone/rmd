// `src/live/box.js` 的纯逻辑判据 —— `design/0047` §2.10。
//
// ⭐ 为什么这一份必须存在：盒子搬运的三类后果里，**有两类任何行为判据都看不见**
//    （外边距不进 border box、横向完全不进高度）⇒ 只能在这一层用假样式表把它钉住。
//
// ⚠️ 变异自测在最后：判据喂给"写坏的副本"必须变红。

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const Box = require('../../src/live/box.js');

/** 造一个 `getComputedStyle` 形状的对象（只给用得上的那几个键，其余留空）。 */
function cs(over) {
  return Object.assign({
    marginTop: '0px',
    marginBottom: '0px',
    paddingTop: '0px',
    paddingRight: '0px',
    paddingBottom: '0px',
    paddingLeft: '0px',
    borderLeftWidth: '0px',
    borderLeftStyle: 'none',
    borderLeftColor: 'rgb(0, 0, 0)',
    borderTopLeftRadius: '0px',
    borderTopRightRadius: '0px',
    borderBottomLeftRadius: '0px',
    borderBottomRightRadius: '0px',
    backgroundColor: 'rgba(0, 0, 0, 0)',
  }, over || {});
}

test('段落：搬走的是那一条段距（正文 1.1 倍）', function () {
  const out = Box.boxOf(cs({ marginBottom: '15.4px' }));
  assert.strictEqual(out['margin-bottom'], '15.4px');
  // ⚠️ 等于"什么也没有"的那些值一律不写（写上去只是把 style 属性撑长）
  assert.ok(!('margin-top' in out), '0px 不该被搬过去');
  assert.ok(!('padding-left' in out));
  assert.ok(!('border-left-style' in out), 'none 不该被搬过去 —— 那会在 host 上凭空长出一条线');
  assert.ok(!('background-color' in out), 'transparent 不该被搬过去');
});

test('列表：左内边距要搬（横向，等高校验完全看不见）', function () {
  const out = Box.boxOf(cs({ paddingLeft: '28px', marginBottom: '15.4px' }));
  assert.strictEqual(out['padding-left'], '28px');
});

test('引用块：内边距 ＋ 左边框 ＋ 底色三件一起搬', function () {
  const out = Box.boxOf(cs({
    paddingTop: '10.5px',
    paddingRight: '14px',
    paddingBottom: '10.5px',
    paddingLeft: '14px',
    borderLeftWidth: '4px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'rgb(0, 117, 105)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
  }));
  assert.strictEqual(out['padding-top'], '10.5px');
  assert.strictEqual(out['padding-left'], '14px');
  assert.strictEqual(out['border-left-width'], '4px');
  assert.strictEqual(out['border-left-style'], 'solid');
  assert.strictEqual(out['border-left-color'], 'rgb(0, 117, 105)');
  assert.ok(!('background-color' in out), '透明底色仍然不写');
});

test('代码块：底色与圆角要搬（字体在 live.css，⛔ 不在这里）', function () {
  const out = Box.boxOf(cs({
    backgroundColor: 'rgb(245, 245, 245)',
    borderTopLeftRadius: '4px',
    borderTopRightRadius: '4px',
    borderBottomLeftRadius: '4px',
    borderBottomRightRadius: '4px',
  }));
  assert.strictEqual(out['background-color'], 'rgb(245, 245, 245)');
  assert.strictEqual(out['border-top-left-radius'], '4px');
  assert.ok(!('font-family' in out), '字体不在清单里 —— 那三样归 live.css');
});

test('空 / 畸形输入一律退化成空对象（⛔ 不许抛）', function () {
  [null, undefined, {}, { marginBottom: 3 }, { marginBottom: '' }].forEach(function (bad) {
    const out = Box.boxOf(bad);
    assert.strictEqual(typeof out, 'object');
    assert.deepStrictEqual(Object.keys(out), []);
  });
});

test('品种类只认标签名（代码块那三样样式的前提）', function () {
  assert.strictEqual(Box.classNameOf({ tagName: 'PRE' }), ' cm-rmd-code');
  ['P', 'H2', 'UL', 'OL', 'BLOCKQUOTE', 'DIV'].forEach(function (tag) {
    assert.strictEqual(Box.classNameOf({ tagName: tag }), '', tag + ' 不该有品种类');
  });
  // ⚠️ 非元素输入不许抛（`swap` 的入参来自调用方，判据要能自己兜住）
  [null, undefined, {}, { tagName: 1 }].forEach(function (bad) {
    assert.strictEqual(Box.classNameOf(bad), '');
  });
});

test('⭐ 块基线是不是标题尺度：只认 h1–h6（`bugs/0015` 的回落前提）', function () {
  // ⚠️ 这一条的用途：标题块里长出来的行要回落成正文（`decorations.js` 的 `cm-rmd-body`），
  //    而"要不要回落"只取决于**被换掉的那个元素**是不是标题。判错方向的后果：
  //    ① 该回落没回落 ⇒ 用户报的那个缺陷（回车之后一直是标题）；
  //    ② 不该回落却回落 ⇒ 引用块 / 代码块的行高被拽成正文的 1.6（整块几何对不上，进不去）。
  assert.strictEqual(Box.headingLevelOf({ tagName: 'H1' }), 1);
  assert.strictEqual(Box.headingLevelOf({ tagName: 'h2' }), 2);
  assert.strictEqual(Box.headingLevelOf({ tagName: 'H6' }), 6);
  ['P', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'H7', 'DIV'].forEach(function (tag) {
    assert.strictEqual(Box.headingLevelOf({ tagName: tag }), 0, tag + ' 不是标题');
  });
  [null, undefined, {}, { tagName: 1 }].forEach(function (bad) {
    assert.strictEqual(Box.headingLevelOf(bad), 0);
  });
});

test('⭐ 清单与行为不许分叉：`PROPS` 里每一条都必须真的被搬', function () {
  // ⚠️ 这一条防的是"清单里加了名字却没生效"——那种分叉在屏幕上表现为某一类块的版面静默跑偏。
  Box.PROPS.forEach(function (p) {
    const sample = {};
    sample[p[1]] = '7px';
    assert.strictEqual(Box.boxOf(cs(sample))[p[0]], '7px', '清单里的 ' + p[0] + ' 没有被搬');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⭐ `design/0085` C2（2026-11-15 用户「批准这份设计」）：长度属性**相对根字号**写。
//
// 症状：`theme.setFontSize()` 只改根变量，已经进编辑态的那块是 swap 时的 px 快照
// ⇒ 改字号后两态尺度不同，直到下一次 swap。修法是把 px 换成
// `calc(var(--reader-font-size) * k + b)`，于是根变量一变，所有 host **自动重解析**。
//
// ⚠️ 判据分三层：① 反解（两点 → k/b）；② 表达式（k/b → CSS 串，含 b=0 / k=0 / b<0）；
//    ③ 写入口（真的写的是表达式、根变量被恢复、品种缓存不重复量）。
// ══════════════════════════════════════════════════════════════════════════

test('C2 反解：两点实测 → k / b（b 是**真的**存在，不是拟合噪声）', function () {
  // 纯比例：引用块行高 1.45 × 字号
  assert.deepStrictEqual(Box.反解(14, 20.3, 28, 40.6), { k: 1.45, b: 0 });
  // 有固定分量：引用条实测 k ≈ 0.2963、b ≈ −0.513（`make probe-type-metrics` 六档拟合）。
  // ⚠️ 这不是"拟合噪声"——浏览器把 `calc(fs × 0.2857)` 的条**吸附**到整设备像素
  //    （12px 档 3.43 ⇒ 3），丢掉 b 之后 12px ⇒ 32px 条宽会少 1 px。
  const 条 = Box.反解(14, 3.5, 28, 7.5);
  assert.ok(Math.abs(条.k - 0.2857142857) < 1e-6, 'k 应为 0.2857');
  assert.ok(Math.abs(条.b + 0.5) < 1e-9, 'b 必须是 −0.5 —— 这一组正是"单点算不出来"的那个分量');
  const 固定 = Box.反解(14, 1, 28, 1);
  assert.deepStrictEqual(固定, { k: 0, b: 1 }, 'B 类物理线宽：k = 0、b = 1px');
});

test('C2 反解：退化输入返回 null（⛔ 不许写出会倒缩的表达式）', function () {
  assert.strictEqual(Box.反解(14, 3, 14, 6), null, '两档相同 ⇒ 量不到差别');
  assert.strictEqual(Box.反解(14, 6, 28, 3), null, '负斜率 ⇒ 量到了噪声');
  assert.strictEqual(Box.反解(NaN, 1, 28, 2), null);
});

test('C2 表达式：三种形状（纯比例 / 有固定分量 / 根本不缩放）', function () {
  assert.strictEqual(Box.表达式(1.45, 0), 'calc(var(--reader-font-size) * 1.45)');
  assert.strictEqual(Box.表达式(2, 0), 'calc(var(--reader-font-size) * 2)');
  assert.strictEqual(Box.表达式(0.2963, -0.513), 'calc(var(--reader-font-size) * 0.2963 - 0.513px)');
  assert.strictEqual(Box.表达式(2, 0.5), 'calc(var(--reader-font-size) * 2 + 0.5px)');
  assert.strictEqual(Box.表达式(0, 1), '1px', 'k = 0 ⇒ 直接给 px，⛔ 不写 `* 0` 的噪声');
  assert.strictEqual(Box.表达式(1.2, 0.0004), 'calc(var(--reader-font-size) * 1.2)',
    'b 舍到 3 位之后是 0 ⇒ 不带固定分量（实测 h1 marginBottom 的 b ≈ −0.004 就是这种）');
});

test('C2 尺度名单：长度项才缩放，字重 / 线型 / 颜色 / 底色原样搬', function () {
  // ⚠️ 名单与 `PROPS` 必须**同进同出**：新加一条长度却忘了进 `尺度` ⇒ 改字号时那一项不动，
  //    而屏幕上表现为"某一类块的某一条尺寸不跟着变"（最典型的是右边距不缩、文字贴边）。
  const 不缩放 = ['font-weight', 'border-left-style', 'border-left-color', 'background-color'];
  Box.PROPS.forEach(function (p) {
    const css = p[0];
    if (不缩放.indexOf(css) >= 0) {
      assert.ok(Box.尺度[css] !== true, css + ' 不该进尺度名单');
    } else {
      assert.strictEqual(Box.尺度[css], true, css + ' 是长度，必须进尺度名单（否则改字号时它不跟）');
    }
  });
});

/** 造一份**假 DOM**：根元素带可读写的 `--reader-font-size`，computed 值随它线性变化。 */
function fakeDom(初始字号) {
  /** @type {Object<string,string>} */
  const 值 = { '--reader-font-size': 初始字号 + 'px' };
  const 根 = {
    style: {
      getPropertyValue: function (k) { return 值[k] || ''; },
      setProperty: function (k, v) { 值[k] = v; },
      removeProperty: function (k) { delete 值[k]; },
    },
    get offsetHeight() { return 0; },
  };
  let 量次数 = 0;
  const win = {
    getComputedStyle: function () {
      量次数 += 1;
      const fs = parseFloat(值['--reader-font-size']);
      return { fontSize: (2 * fs) + 'px', marginBottom: (1.1 * fs) + 'px', backgroundColor: 'transparent' };
    },
  };
  return { 根: 根, win: win, 值: 值, 量次数: function () { return 量次数; } };
}

test('C2 写入口：真的写 `calc(...)`，且量完把根变量**原样放回去**', function () {
  const dom = fakeDom(14);
  const 旧 = Object.prototype.hasOwnProperty.call(global, 'document') ? global.document : undefined;
  global.document = /** @type {any} */ ({ documentElement: dom.根 });
  try {
    const mod = load(SRC, dom.win);
    /** @type {Array<[string,string]>} */
    const 写 = [];
    const host = { style: { setProperty: function (k, v) { 写.push([k, v]); } } };
    mod.applyBox(host, { tagName: 'P' });
    assert.deepStrictEqual(写, [
      ['font-size', 'calc(var(--reader-font-size) * 2)'],
      ['margin-bottom', 'calc(var(--reader-font-size) * 1.1)'],
    ], '写出去的必须是表达式 —— 裸 px 就是 C2 那个"改字号后停在旧快照"的原样');
    assert.strictEqual(dom.值['--reader-font-size'], '14px',
      '量第二档改过根变量 ⇒ 必须恢复原值（否则整篇文档停在一个错误字号上）');
  } finally {
    if (旧 === undefined) delete global.document;
    else global.document = 旧;
  }
});

test('C2 写入口：同一个品种只量一次（量第二档 = 一次全篇重排，⛔ 不能每块都付）', function () {
  const dom = fakeDom(14);
  const 旧 = Object.prototype.hasOwnProperty.call(global, 'document') ? global.document : undefined;
  global.document = /** @type {any} */ ({ documentElement: dom.根 });
  try {
    const 缓存模块 = load(SRC, dom.win);
    const host = { style: { setProperty: function () {} } };
    缓存模块.applyBox(host, { tagName: 'P' });
    const 首块 = dom.量次数();
    缓存模块.applyBox(host, { tagName: 'P' });
    缓存模块.applyBox(host, { tagName: 'P' });
    assert.strictEqual(dom.量次数(), 首块 + 2, '第二、三个 <p> 只该各量**一次**（命中缓存）');
    缓存模块.applyBox(host, { tagName: 'H2' });
    assert.strictEqual(dom.量次数(), 首块 + 4, '另一个品种（h2）要重新量一档');
  } finally {
    if (旧 === undefined) delete global.document;
    else global.document = 旧;
  }
});

test('C2 兜底：没有 DOM / 没有根字号 ⇒ 退回裸 px（旧行为，⛔ 不许抛）', function () {
  const 旧 = Object.prototype.hasOwnProperty.call(global, 'document') ? global.document : undefined;
  if (旧 !== undefined) delete global.document;
  try {
    const mod = load(SRC, { getComputedStyle: function () { return { marginBottom: '15.4px' }; } });
    /** @type {Array<[string,string]>} */
    const 写 = [];
    const host = { style: { setProperty: function (k, v) { 写.push([k, v]); } } };
    assert.doesNotThrow(function () { mod.applyBox(host, { tagName: 'P' }); });
    assert.deepStrictEqual(写, [['margin-bottom', '15.4px']], '量不到根字号 ⇒ 裸 px（不是不写）');
  } finally {
    if (旧 !== undefined) global.document = 旧;
  }
});


//    改 `api.PROPS` / `api.INERT` 一行都不会影响它已经捕获的那两份常量
//    ——那正是"没改到，而输出与'判据不敏感'一模一样"的陷阱。
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live', 'box.js'), 'utf8');

/** 在**独立模块作用域**里跑一遍源码（不碰全局 `window`）。 */
function load(src, win) {
  const mod = { exports: {} };
  new Function('module', 'window', src)(mod, win);
  return mod.exports;
}

test('⭐ 变异自测：三处写坏必须各自让对应判据变红（先证明改到了）', function () {
  // M1：清单里删掉 `padding-left`（列表整体左跳，没有任何别的判据能发现）
  const m1 = SRC.replace("['padding-left', 'paddingLeft'],", '');
  assert.notStrictEqual(m1, SRC, 'M1 没改到');
  assert.ok(!('padding-left' in load(m1).boxOf(cs({ paddingLeft: '28px' }))), 'M1 没红');

  // M2：`INERT` 里删掉 `'0px'`（每次 swap 都会把一串 0 写进 `style`，把属性撑长）
  const m2 = SRC.replace("'0px': true,", '');
  assert.notStrictEqual(m2, SRC, 'M2 没改到');
  assert.strictEqual(load(m2).boxOf(cs({ marginBottom: '0px' }))['margin-bottom'], '0px', 'M2 没红');

  // M3：`classNameOf` 不认 `pre`（代码块套不上等宽字体与内边距）
  const m3 = SRC.replace("if (tag === 'pre') return ' cm-rmd-code';", '');
  assert.notStrictEqual(m3, SRC, 'M3 没改到');
  assert.strictEqual(load(m3).classNameOf({ tagName: 'pre' }), '', 'M3 没红');

  // M4：`headingLevelOf` 永远返回 0（`bugs/0015` 原样打回：标题块里的新行不回落）
  //    ⚠️ 变异点是**正则那一行**，⛔ 不是改 `return`：那样 `H7` 那几条会跟着变红，
  //    分不清"判据不敏感"与"变异范围太大"。
  const m4 = SRC.replace('const m = /^H([1-6])$/.exec(el.tagName.toUpperCase());',
    'const m = /^$/.exec(el.tagName.toUpperCase());');
  assert.notStrictEqual(m4, SRC, 'M4 没改到');
  assert.strictEqual(load(m4).headingLevelOf({ tagName: 'H2' }), 0, 'M4 没红');
  assert.strictEqual(load(m4).headingLevelOf({ tagName: 'P' }), 0, 'M4 只该打红"是标题"那一半');
});
