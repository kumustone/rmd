// `design/0084`（2026-11-15 用户批准「按照你的建议执行」）：**列表标记由 UA 画**。
//
// # 这一份要钉住什么
//
// 阅读态的圆点/编号是浏览器对 `<li>` 的 `::marker` 画的；编辑态**曾经**用绝对定位的
// `::before` 手绘一枚去逼近它（直径 `.357em`、让位 `.7857em`、环径 `.4286em`、
// 编号让位 `calc(.09em + 2.5px)`、`tabular-nums`、`max-content` ＋ `translateX(-100%)`）。
// 那一族全是**从栅格反推的拟合常数** ⇒ 每换一档字号/位数/层数就要再补一条，
// 用户反复感到「进出编辑态重新渲染」（`bugs/0101` / `0112` B2-m / B2-m-5 三代）。
//
// 现在两态由**同一段代码**画标记：编辑行 `display: list-item`，缩进写在 `margin-left` 上，
// 字形按层数由 `live.css` 的关键字表给（与 `typography.css` 同词汇）。
// ⇒ 判据分四半：
//   ① **形状**：三种品种都真的成了列表项（`display: list-item` ＋ `outside`）；
//   ② **缩进放对盒子**：`margin-left`，⛔ 不是 `padding-left`（后者会让标记整体左移一个缩进，
//      离屏实测 64 设备 px，`bugs/0113` §8）；
//   ③ **三层圆点**：`disc` / `circle` / `square`，与 UA 级联同映射（`bugs/0321`）；
//   ④ **拟合常数一族不许回来**（源码级闸门 ＋ 变异）。
//
// # 变异台账（2026-11-15 实跑）
//
// | 变异 | 结果 |
// |---|---|
// | 删掉 `display: list-item` | ✅ 红「列表项」 |
// | `margin-left` 改回 `padding-left` | ✅ 红「缩进盒子」 |
// | 把 `.357em` 塞回 `live.css` | ✅ 红「拟合常数」 |
// | 圆点层数写死成 0 | ✅ 红「三层圆点」 |

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const LIVE_CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'live.css'), 'utf8');
const TYPO = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'typography.css'), 'utf8');
const DECO = fs.readFileSync(path.join(ROOT, 'src', 'live', 'decorations.js'), 'utf8');

/** 把样式表拆成 `[{sel, body}]`（`live.css` 里没有 `@media`，扁平的够用）。 */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!sel) continue;   // 注释里的花括号不算规则
    out.push({ sel: sel, body: m[2] });
  }
  return out;
}

/** 选中所有「选择器里含 `needle`」的规则体。 */
function bodies(css, needle) {
  return rules(css).filter(function (r) { return r.sel.indexOf(needle) >= 0; })
    .map(function (r) { return r.body; });
}

/**
 * 去掉注释：常数闸门判的是**声明**，⛔ 不是历史注释里那些被删掉的数字
 * （新注释必须能写「以前是 `.357em`」而不触发自己）。
 */
function 去注释(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 圆点/有序/任务三种品种。 */
const 品种 = ['bullet', 'ordered', 'task'];

/**
 * 全部判据合成一个函数，返回违规列表（空 = 全绿）。
 * ⚠️ 变异自测靠它——⛔ 别把判据只写在 `assert` 里，那样"写坏了哪条"分不出来。
 * @param {{live: string, deco: string, typo: string}} 源
 * @returns {string[]}
 */
function 检查(源) {
  const bad = [];

  // ① 三种品种都必须是**真正的列表项**：与阅读态 `<li>` 同一个排版对象。
  for (const k of 品种) {
    const 体 = bodies(源.live, '[data-rmd-li="' + k + '"]');
    const 列表项 = 体.some(function (b) {
      return /display:\s*list-item/.test(b) && /list-style-position:\s*outside/.test(b);
    });
    if (!列表项) {
      bad.push('品种 ' + k + ' 的行不是 `display: list-item; list-style-position: outside` —— '
        + '标记只能又回到手绘（`::before` 那一族）');
    }
  }

  // ② 缩进必须写在 `margin-left` 上（`::marker` 按边框盒定位）。
  if (!/style:\s*'margin-left: '\s*\+\s*几何\.marginLeft/.test(源.deco)) {
    bad.push('缩进盒子：`listDeco` 没把缩进写在 `margin-left` 上 —— '
      + '写在 `padding-left` 上时 UA 的标记整体左移一个缩进（实测 64 设备 px，`bugs/0113` §8）');
  }
  if (!/列表几何At\(li\.depth\)/.test(源.deco)) {
    bad.push('缩进量没接上 `live/geometry.js` 的 `listGeometryAt`（`design/0065` 的单一真相）');
  }

  // ③ 三层圆点：与 UA 级联同映射（`ul` ⇒ disc、`ul ul` ⇒ circle、更深 ⇒ square）。
  const 应 = { 0: 'disc', 1: 'circle', 2: 'square' };
  for (const lv of Object.keys(应)) {
    const 体 = bodies(源.live, '[data-rmd-li="bullet"][data-rmd-li-level="' + lv + '"]');
    if (!体.some(function (b) {
      return new RegExp('list-style-type:\\s*' + 应[lv] + '\\b').test(b);
    })) {
      bad.push('三层圆点：第 ' + lv + ' 层没有 `list-style-type: ' + 应[lv] + '`');
    }
  }
  if (!/Math\.min\(层, 2\)/.test(源.deco)) {
    bad.push('三层圆点：`listDeco` 没把圆点层数夹到 2 —— 更深层的 `data-rmd-li-level` 没有规则，'
      + '会静默落回 `disc`（又变成"每层都实心圆"）');
  }

  // ④ 任务项的标记必须让出来（阅读态是 `.doc li.task-list-item { list-style: none }`）。
  const 任务 = bodies(源.live, '[data-rmd-li="task"]');
  if (!任务.some(function (b) { return /list-style-type:\s*none/.test(b); })) {
    bad.push('任务项缺 `list-style-type: none` —— 方框左边会多一个圆点');
  }
  if (!/\.doc li\.task-list-item\s*\{\s*list-style:\s*none/.test(源.typo)) {
    bad.push('阅读态的任务项规则不见了（`.doc li.task-list-item { list-style: none }`）——'
      + '两边口径必须同一句话');
  }

  // ⑤ 拟合常数一族不许回来：`::before` 那整套、四个 em 系数、编号让位、等宽数字、旧属性名。
  const 常数 = [/::before/, /--rmd-li-/, /\.357em/, /\.7857em/, /\.4286em/, /\.0714em/,
    /tabular-nums/, /data-rmd-marker/, /data-rmd-li-shape/,
    /padding-right:\s*calc\(/];
  const 声明 = 去注释(源.live);
  const 命中 = 常数.filter(function (re) { return re.test(声明); });
  if (命中.length) {
    bad.push('拟合常数：`live.css` 里又出现了 ' + 命中.map(String).join(' / ')
      + ' —— 标记必须由 UA 画，⛔ 别再用栅格反推的系数去凑');
  }
  const js声明 = 去注释(源.deco);
  for (const name of ['data-rmd-marker', 'data-rmd-li-shape', '--rmd-li-']) {
    if (js声明.indexOf(name) >= 0) {
      bad.push('拟合常数：`decorations.js` 里又出现了 `' + name + '`');
    }
  }
  return bad;
}

test('⭐ 基线：四种品种 / 缩进盒子 / 三层圆点 / 无拟合常数（`design/0084`）', function () {
  assert.deepStrictEqual(检查({ live: LIVE_CSS, deco: DECO, typo: TYPO }), []);
  // 表本身得**真的存在**：0 条也会"没有违规"。
  assert.strictEqual(bodies(LIVE_CSS, '[data-rmd-li="bullet"][data-rmd-li-level="').length, 3,
    '圆点三级形状表条数');
});

test('⭐ 纯函数面还在：`bulletShape` 仍按 UA 级联给三层（`bugs/0321`）', function () {
  const D = require('../../src/live/decorations.js');
  assert.deepStrictEqual([0, 1, 2, 3].map(function (lv) { return D.bulletShape(lv); }),
    ['disc', 'circle', 'square', 'square'], '与阅读态 UA 级联同口径');
  // ⚠️ `CSS 关键字` 与 `bulletShape` 的返回值是**同一套词**（选择器里写的就是它）。
  for (const shape of ['disc', 'circle', 'square']) {
    assert.ok(LIVE_CSS.indexOf('list-style-type: ' + shape) >= 0,
      '`live.css` 里没有 `list-style-type: ' + shape + '` —— 属性贴了却没有形状');
  }
});

test('⭐⭐ 变异自测：四处写坏各必须让**对应**判据变红', function () {
  const has = function (list, needle) {
    return list.some(function (x) { return x.indexOf(needle) >= 0; });
  };
  const 基线 = { live: LIVE_CSS, deco: DECO, typo: TYPO };
  assert.deepStrictEqual(检查(基线), [], '基线必须先全绿，否则下面分不清是谁的红');

  // m1：删掉 `display: list-item` ⇒ 行退回普通块，UA 不会画标记。
  const m1src = LIVE_CSS.replace(/\n\s*display:\s*list-item;/, '');
  assert.notStrictEqual(m1src, LIVE_CSS, 'm1 没改到（靶子漂移）');
  assert.ok(has(检查(Object.assign({}, 基线, { live: m1src })), '不是 `display: list-item'), 'm1 没红');

  // m2：缩进改回 `padding-left` ⇒ 标记整体左移一个缩进（0113 §8 的那 64 设备 px）。
  const m2src = DECO.replace("style: 'margin-left: ' + 几何.marginLeft",
    "style: 'padding-left: ' + 几何.marginLeft");
  assert.notStrictEqual(m2src, DECO, 'm2 没改到（靶子漂移）');
  assert.ok(has(检查(Object.assign({}, 基线, { deco: m2src })), '缩进盒子'), 'm2 没红');

  // m3：把圆点直径系数塞回 `live.css` ⇒ 拟合常数闸门红。
  const m3src = LIVE_CSS.replace(/\n\s*list-style-position: outside;/,
    '\n  list-style-position: outside; --rmd-li-dot: .357em;');
  assert.notStrictEqual(m3src, LIVE_CSS, 'm3 没改到（靶子漂移）');
  assert.ok(has(检查(Object.assign({}, 基线, { live: m3src })), '拟合常数'), 'm3 没红');

  // m4：圆点层数写死成 0 ⇒ 二层起全部落回 `disc`（`bugs/0321` 重现）。
  const m4src = DECO.replace('Math.min(层, 2)', 'Math.min(0, 2)');
  assert.notStrictEqual(m4src, DECO, 'm4 没改到（靶子漂移）');
  assert.ok(has(检查(Object.assign({}, 基线, { deco: m4src })), '三层圆点'), 'm4 没红');
});
