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

// ⚠️⚠️ 变异测试对**源码**做、⛔ 不是改导出对象：`boxOf` 是 IIFE 里的闭包，
//    改 `api.PROPS` / `api.INERT` 一行都不会影响它已经捕获的那两份常量
//    ——那正是"没改到，而输出与'判据不敏感'一模一样"的陷阱。
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live', 'box.js'), 'utf8');

/** 在**独立模块作用域**里跑一遍源码（不碰全局 `window`）。 */
function load(src) {
  const mod = { exports: {} };
  new Function('module', 'window', src)(mod, undefined);
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
