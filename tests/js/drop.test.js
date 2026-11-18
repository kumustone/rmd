// `design/0071` §2（阶段 1：拖入窗口，2026-11-14 已通过）的**判据**。
//
// # 这一格守的是什么
//
// 拖放这件事上有三类错误**不会报任何错**：
// ① **路径从拖放通道漏进前端**（`INV-OPEN-01`）。Tauri 的 `tauri://drag-*` 事件载荷里
//    带 `paths`，前端只要 `listen` 一下，路径就成了一枚前端变量——之后它可以被任何
//    脚本读到、被打进日志、被拼进文案。⚠️ 而"订阅了一下来看看"**是零成本的**，
//    所以这条只能靠源码闸门守：`src/**` 里⛔ 不许出现 `tauri://drag`。
// ② **遮罩卡住**（`leave` 丢了）。屏幕上一块半透明底永远盖着正文，
//    用户不知道该怎么办；而它不长在任何一条错误路径上（`design/0071` §2.4 最后一行）。
// ③ 遮罩**不认识的事件**被当成"清空"（拖动过程中闪一下）或被当成"显示"（永远显示）。
//    ⇒ 状态机的 `reduce` 是**纯函数**，默认动作是"原样不动"。
//
// ⚠️ 判据对**注释免疫**：源码里大量写着"⛔ 别写成 X"，所以源码级判据先剥注释
//    （与 `failbar.test.js` 同一手法）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const D = require('../../src/services/drop.js');

const ROOT = path.join(__dirname, '..', '..');
const read = function (p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); };

function stripBlockComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

function stripLineComments(src) {
  return String(src).split('\n').map(function (line) {
    const i = line.indexOf('//');
    if (i < 0) return line;
    const before = line.slice(0, i);
    const quotes = (before.match(/["']/g) || []).length;
    if (quotes % 2 === 1) return line;
    return before;
  }).join('\n');
}

function strip(src) { return stripLineComments(stripBlockComments(src)); }

/** `src/` 下所有 `.js` / `.html`（不递归 `vendor/`：那是构建产物，⛔ 不是我们的源码）。 */
function sourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = dir + '/' + name;
      const st = fs.statSync(path.join(ROOT, rel));
      if (st.isDirectory()) {
        if (name === 'vendor' || name === 'node_modules') continue;
        walk(rel);
      } else if (/\.(js|html)$/.test(name)) {
        out.push(rel);
      }
    }
  })('src');
  return out;
}

// ── ① 状态机（纯函数） ────────────────────────────────────────────────

test('遮罩状态机：enter 显示', function () {
  assert.deepStrictEqual(D.reduce({ visible: false }, 'enter'), { visible: true });
});

test('遮罩状态机：leave / drop / blur 都清空（三条兜底，任一成立）', function () {
  for (const ev of ['leave', 'drop', 'blur']) {
    assert.deepStrictEqual(D.reduce({ visible: true }, ev), { visible: false }, ev);
  }
});

test('遮罩状态机：不认识的事件**原样不动**（⛔ 不清空、⛔ 不显示）', function () {
  // 清空会让拖动中途闪一下；显示会让遮罩永远下不来。
  assert.deepStrictEqual(D.reduce({ visible: true }, 'over'), { visible: true });
  assert.deepStrictEqual(D.reduce({ visible: false }, 'over'), { visible: false });
  assert.deepStrictEqual(D.reduce({ visible: true }, ''), { visible: true });
  assert.deepStrictEqual(D.reduce({ visible: true }, undefined), { visible: true });
});

test('遮罩状态机：enter → leave → blur 一条链走完是"干干净净"', function () {
  // ⭐ 这就是 `design/0071` §7 那条 JS 判据原话（enter→leave→失焦清空）。
  let s = { visible: false };
  s = D.reduce(s, 'enter');
  assert.strictEqual(s.visible, true);
  s = D.reduce(s, 'leave');
  assert.strictEqual(s.visible, false);
  s = D.reduce(s, 'enter');
  s = D.reduce(s, 'blur');
  assert.strictEqual(s.visible, false, '失焦必须清——它挡的是"leave 丢了"那一档');
});

test('遮罩状态机：重复同一个事件是幂等的', function () {
  assert.deepStrictEqual(D.reduce(D.reduce({ visible: false }, 'enter'), 'enter'), { visible: true });
  assert.deepStrictEqual(D.reduce(D.reduce({ visible: true }, 'leave'), 'leave'), { visible: false });
});

// ── ② DOM 开关（假元素，⛔ 不碰 document） ─────────────────────────────

function fakeEl() {
  return {
    hidden: true,
    attrs: {},
    setAttribute: function (k, v) { this.attrs[k] = v; },
  };
}

test('遮罩 DOM：建的时候是藏的，enter 之后才取消 hidden', function () {
  const el = fakeEl();
  const o = D.createOverlay({ el: el });
  assert.strictEqual(el.hidden, true);
  assert.strictEqual(el.attrs['aria-hidden'], 'true');
  assert.strictEqual(o.send('enter'), true);
  assert.strictEqual(el.hidden, false);
  assert.strictEqual(el.attrs['aria-hidden'], 'false');
  assert.strictEqual(o.send('leave'), false);
  assert.strictEqual(el.hidden, true);
  assert.strictEqual(el.attrs['aria-hidden'], 'true');
});

test('遮罩 DOM：`reset()` 不依赖事件序（启动 / 出错时直接摆平）', function () {
  const el = fakeEl();
  const o = D.createOverlay({ el: el });
  o.send('enter');
  o.reset();
  assert.strictEqual(el.hidden, true);
  assert.strictEqual(o.visible(), false);
});

test('遮罩 DOM：节点不存在时**不抛**（只少了视觉反馈，打开仍然有效）', function () {
  const o = D.createOverlay({ doc: { getElementById: function () { return null; } } });
  assert.strictEqual(o.send('enter'), true);
  assert.strictEqual(o.send('leave'), false);
  assert.strictEqual(o.element(), null);
});

test('遮罩 DOM：能从 `doc` 里按 id 找到自己那个节点', function () {
  const el = fakeEl();
  const o = D.createOverlay({ doc: { getElementById: function (id) { return id === 'drop-overlay' ? el : null; } } });
  assert.strictEqual(o.element(), el);
  o.send('enter');
  assert.strictEqual(el.hidden, false);
});

// ── ③ 源码闸门 ────────────────────────────────────────────────────────

test('闸门：`src/**` 里⛔ 没有任何一处订阅 `tauri://drag`（`INV-OPEN-01`）', function () {
  // ⚠️ 那四条事件的载荷里带 `paths`。订阅一下，路径就进了 JS——
  //    而 Tauri 那边的 `emit_js_filter` **只在有 JS 监听者时才真的发**，
  //    ⇒ "不订阅"本身就是那条不变量的实现手段，⛔ 不是"顺手省一处"。
  for (const rel of sourceFiles()) {
    const src = strip(read(rel));
    assert.ok(src.indexOf('tauri://drag') < 0,
      rel + ' 订阅了 tauri://drag-*：路径会随载荷进前端（INV-OPEN-01）');
  }
});

test('闸门：拖放的三条通道确实接上了（⛔ 别只剩一条）', function () {
  const src = strip(read('src/main.js'));
  for (const ev of ['rmd://drag', 'rmd://drop-reject', 'rmd://root-changed']) {
    assert.ok(src.indexOf("T.listen('" + ev + "'") >= 0, 'main.js 没有订阅 ' + ev);
  }
});

test('闸门：拒绝理由**只认** `drop.reject.` 前缀（⛔ 不让任意 key 进字典）', function () {
  const src = strip(read('src/main.js'));
  assert.ok(src.indexOf("'drop.reject.'") >= 0, 'main.js 少了前缀白名单');
  // ⚠️ 前缀判据必须真的**用在** `onDropReject` 里，⛔ 只是一句没用的字符串。
  const fn = src.slice(src.indexOf('function onDropReject'));
  assert.ok(fn.slice(0, fn.indexOf('\n  }')).indexOf('indexOf(') >= 0,
    'onDropReject 里没有做前缀判断');
});

test('闸门：`services/drop.js` 排在 `main.js` 之前（经典脚本按序执行）', function () {
  const html = read('src/index.html');
  const drop = html.indexOf('src="services/drop.js"');
  const main = html.indexOf('src="main.js"');
  assert.ok(drop >= 0, 'index.html 没有加载 services/drop.js');
  assert.ok(main >= 0, 'index.html 没有加载 main.js');
  assert.ok(drop < main, 'services/drop.js 必须排在 main.js 之前');
});

test('闸门：遮罩骨架在 HTML 里、且文案走 `data-i18n`（⛔ 不写死两套文字）', function () {
  const html = read('src/index.html');
  assert.ok(html.indexOf('id="drop-overlay"') >= 0, 'index.html 少了 #drop-overlay');
  assert.ok(html.indexOf('data-i18n="drop.hint"') >= 0, '遮罩文案没有走 i18n');
  assert.ok(/id="drop-overlay"[^>]*\bhidden\b/.test(html), '遮罩出厂必须是 hidden（否则启动就盖着正文）');
});

test('闸门：i18n 两张表都有那六条 key（漏一条 = 界面上显示 key 本身）', function () {
  // ⚠️ 判据走模块 API，⛔ 不扫源码：i18n.js 里有跨行的块注释，
  //    朴素的"先剥注释再 grep"会连正文一起剥掉（本条第一版就是这么错的）。
  const I = require('../../src/services/i18n.js');
  const keys = ['drop.hint', 'drop.reject.editing', 'drop.reject.multi',
    'drop.reject.not-markdown', 'drop.reject.unreadable', 'drop.reject.root'];
  for (const k of keys) {
    assert.ok(I.has(k, 'zh'), k + ' 缺中文');
    assert.ok(I.has(k, 'en'), k + ' 缺英文');
  }
});

test('闸门：CSS 的 `.drop-overlay` 不吃指针事件且压在所有覆盖层之上', function () {
  const css = strip(read('src/style.css'));
  const i = css.indexOf('.drop-overlay {');
  assert.ok(i >= 0, 'style.css 少了 .drop-overlay');
  const block = css.slice(i, css.indexOf('}', i));
  assert.ok(block.indexOf('pointer-events: none') >= 0,
    '遮罩必须不吃指针事件（拖放的落点是下面那些真实元素）');
  const z = /z-index:\s*(\d+)/.exec(block);
  assert.ok(z, '遮罩必须给 z-index');
  // 本仓层序：正文 10–30 / 就地编辑 35 / 设置与 ⌘P 40 / 查找 45 / 看图 50。
  assert.ok(Number(z[1]) > 50, '遮罩要压过看图那一层（50），实际 ' + z[1]);
  assert.ok(block.indexOf('color-mix(') >= 0,
    '半透明底必须走 color-mix（INV-THEME-02：⛔ 不写 rgba 字面量）');
});

// ── ④ 判据自己承不承重（变异自测） ────────────────────────────────────
//
// ⚠️ 没有变异测试的断言不算数（`.claude/rules/tests.md`）：上面那些判据
//    今天全绿，也可能是因为它们**根本没看那个东西**。

test('变异自测：去掉 `blur` 那条兜底，"失焦必须清"必须变红', function () {
  const vm = require('node:vm');
  const src = read('src/services/drop.js');
  // ⚠️ 靶子是一个**声明行**（⛔ 不用整块文本）：换个引号或对齐就会"没改到"，
  //    而"没改到"与"判据不敏感"的输出一模一样。
  const mutated = src.replace(
    "const HIDE = ['leave', 'drop', 'blur'];",
    "const HIDE = ['leave', 'drop'];"
  );
  assert.notStrictEqual(mutated, src, '变异没命中目标 —— 判据的靶子漂移了');
  const ctx = { module: { exports: {} }, console: console };
  vm.runInNewContext(mutated, ctx);
  const M = ctx.module.exports;
  assert.strictEqual(M.reduce({ visible: true }, 'blur').visible, true,
    '去掉 blur 之后判据还绿 —— 它不承重');
});

test('变异自测：真写了 `tauri://drag`，源码闸门必须能抓到', function () {
  const fake = "await T.listen('tauri://drag-enter', function () {});";
  assert.ok(strip(fake).indexOf('tauri://drag') >= 0, '闸门的判据串没命中真实代码形态');
  // 负对照：**注释里**提到它不算（否则文件头的纪律说明会把自己判红）。
  assert.strictEqual(strip('// ⛔ 别 listen tauri://drag\n').indexOf('tauri://drag'), -1,
    '剥注释没生效 —— 闸门会把文档判成实现');
});
