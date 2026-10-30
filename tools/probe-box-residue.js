#!/usr/bin/env node
// 探针：`applyBox` **不是自清的** —— 同一个 host 上换了块，上一种块的盒子会残留。
//
// 出处：`docs/reviews/2026-10-29-前端编辑内核-长跑走查.md` 的 N1。
//
// 为什么是探针而不是 `tests/js/` 里的用例：
//   `make test-js` 必须全绿，而这条**今天就是红的**（缺陷在场）。写成"断言残留存在"
//   会让下一个修它的人撞一道绿门 —— 判据留在 `tools/`，⛔ 不进闸门。
//   修法（`applyBox` 自清，或 `reseat` 前复位）落地之后，把这里改成断言"残留为空"
//   再挪进 `tests/js/live-box.test.js`。
//
// ⚠️ 纯逻辑：只 require `src/live/box.js`，`window.getComputedStyle` 用桩替换。
//    不建窗口、不碰磁盘、不联网。
// 退出码：0 = 无残留（缺陷已修）；1 = 有残留（缺陷在场）；2 = 前置没造出来。

'use strict';

const path = require('node:path');

/**
 * 两种块的计算样式（值取自三套主题的实际量级，**只用来区分两种块**）。
 * ⚠️ 键名是 `getComputedStyle` 的驼峰名，与 `box.js::PROPS` 第二列对齐。
 */
const STYLE = {
  blockquote: {
    fontSize: '14px',
    lineHeight: '20.3px',
    fontWeight: '400',
    marginTop: '0px',
    marginBottom: '15.4px',
    paddingTop: '0px',
    paddingRight: '0px',
    paddingBottom: '0px',
    paddingLeft: '24px',
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'rgb(200, 200, 200)',
    borderTopLeftRadius: '0px',
    borderTopRightRadius: '0px',
    borderBottomLeftRadius: '0px',
    borderBottomRightRadius: '0px',
    backgroundColor: 'transparent',
  },
  paragraph: {
    fontSize: '14px',
    lineHeight: '20.3px',
    fontWeight: '400',
    marginTop: '0px',
    marginBottom: '15.4px',
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
    backgroundColor: 'transparent',
  },
};

const BOX = require(path.join(__dirname, '..', 'src', 'live', 'box.js'));

/** 假的 `#doc` 孩子：只有 `tagName`。 */
function el(tag) {
  return { tagName: tag.toUpperCase() };
}

/** 假 host：`style.setProperty` 落进一个 Map，方便列残留。 */
function host() {
  const props = new Map();
  return {
    style: {
      setProperty: function (k, v) {
        props.set(k, v);
      },
      // ⚠️ 真 `CSSStyleDeclaration` 有这一个；自清那种修法要用它，探针必须能承载
      //    （否则"修好之后探针转绿"这条反向证明根本跑不起来）。
      removeProperty: function (k) {
        props.delete(k);
      },
    },
    props: props,
  };
}

function install(style) {
  global.window = {
    getComputedStyle: function () {
      return style;
    },
  };
}

function main() {
  // 前置：两种块的盒子**必须不一样**（否则"残留"这个词没有意义，结论无效）。
  const a = BOX.boxOf(STYLE.blockquote);
  const b = BOX.boxOf(STYLE.paragraph);
  const diff = Object.keys(a).filter(function (k) {
    return b[k] !== a[k];
  });
  if (diff.length === 0) {
    console.log('⛔ 前置不成立：引号块与段落的盒子没有差别，造不出残留');
    return 2;
  }

  // ① 先搬引用块，② 再在**同一个 host** 上搬段落（`reseat` 复用 host 就是这个形状）。
  const h = host();
  install(STYLE.blockquote);
  BOX.applyBox(h, el('blockquote'));
  install(STYLE.paragraph);
  BOX.applyBox(h, el('p'));

  // 残留的判据：**段落这一轮根本没写这一项**（`boxOf` 按 `INERT` 丢掉了），而 host 上
  // 还留着引用块写进去的值。⚠️ 段落**自己写了**的项不算残留——那项已经被覆盖成对的。
  const residue = Object.keys(a).filter(function (k) {
    return b[k] === undefined && h.props.get(k) === a[k];
  });

  console.log('引用块写入 =', a);
  console.log('段落写入   =', b);
  console.log('host 最终   =', Object.fromEntries(h.props));
  if (residue.length === 0) {
    console.log('✅ 无残留：换块之后 host 上只剩这一种块的盒子');
    return 0;
  }
  console.log('⛔ 残留（Host 上留着上一种块的值）：');
  residue.forEach(function (k) {
    console.log('   · ' + k + '=' + h.props.get(k) + '（本应 不写）');
  });
  console.log(
    '   路径：`boxOf()` 对 `0px` / `none` / `transparent` **不写**（`INERT`），' +
      '`applyBox()` 也**不清**上一次写过的键。\n' +
      '   今天不可达靠的是"两个调用点都喂干净 host"（`makeLiveView` 新建、`swapLiveView` 前有 undo 清 style），\n' +
      '   ⛔ 没有任何判据守着这个前置条件。'
  );
  return 1;
}

process.exitCode = main();
