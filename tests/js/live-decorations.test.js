// `design/0047` §2.9 装饰层的**纯逻辑判据**：该隐藏哪些标记、哪些行必须有行级品种类。
//
// ⚠️ 这一份测的是 `src/live/decorations.js::markers()`（纯函数，不碰 CM6 也不碰 DOM）。
//    真正的 `Decoration` 行为（零宽替换、`RangeError`）要真 `EditorView` ⇒ 那半在 §7.2 的接线闸门。
//
// ⭐ 三类错在屏幕上都不报错：
//   ① 藏进围栏内部（代码块的内容被吃掉）；
//   ② 隐藏集合跟着选区变（`design/0061` L1 之后这就是缺陷：进编辑态文字会变回源码）；
//   ③ 区间差一（`Decoration` 抛错 ⇒ 整块白屏）。
//
// ⭐⭐ **2026-10-27（`design/0052` U3）起判据来自语法树**，于是这一份也必须自己造树：
//    用**产品同一个解析器**（`markdownLanguage` ＝ `markdown()` 换的那个 base）parse 一份，
//    ⛔ 不另写第二套正则——那正是被本单元删掉的东西。
//    ⚠️ 好处是期望值仍然**逐字**：树只决定"哪些区间藏"，藏出来是什么由源码切片说了算。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const D = require('../../src/live/decorations.js');
// ⚠️ `@codemirror/lang-markdown` 是 ESM，但 node ≥ 22.12 的 `require(esm)` 能直接取到命名导出。
//    ⇒ 这里拿到的是**产品同一个**解析器，⛔ 不是另装一份 `@lezer/markdown`。
const { markdownLanguage } = require('@codemirror/lang-markdown');

/** 造一棵树——`markers()` 的唯一判据来源。 */
function parse(text) {
  return markdownLanguage.parser.parse(String(text));
}

/** `D.markers()` ＋ 自动补树（显式传 `tree` 时以传入的为准）。 */
function marks(text, opts) {
  const o = Object.assign({}, opts);
  if (!o.tree) o.tree = parse(text);
  return D.markers(text, o);
}

/** 把区间还原成被藏掉的**字面串**，便于断言（也顺带验证区间不越界）。 */
function hidden(text, opts) {
  return marks(text, opts).ranges.map(function (r) {
    return text.slice(r.from, r.to);
  });
}

test('⚠️ **没有树就什么都不藏**——有意的可见降级（⛔ 不是错位、也⛔ 不抛错）', function () {
  assert.deepStrictEqual(D.markers('# 标题').ranges, [], '没有 tree ⇒ 一个标记都不藏');
  assert.deepStrictEqual(D.markers('# 标题').headings, [], '没有 tree ⇒ 也没有行级品种类');
  assert.deepStrictEqual(D.markers('# 标题', { bodyLines: true }).bodies.map(function (b) { return b.line; }),
    [0], '⚠️ 但没有行级品种类时**每一行都算正文行**（块基线是标题时必须回落）');
  assert.deepStrictEqual(D.markers('# 标题', { tree: null }).ranges, []);
});

test('标题：只藏 `#` 与**一个**空格（⛔ 不藏缩进、⛔ 不藏标题文字）', function () {
  assert.deepStrictEqual(hidden('# 标题'), ['# ']);
  assert.deepStrictEqual(hidden('### 标题'), ['### ']);
  assert.deepStrictEqual(hidden('#没有空格'), [], '没有空格就不成标题（CommonMark 同口径）');
  assert.deepStrictEqual(hidden('####### 七个'), [], '七个 # 不是标题');
});

// ⭐⭐ `design/0061` L1：隐藏集合**只由源码决定**，与光标 / 选区无关。
//    ⚠️ 这是「进入编辑态 → 文字变回源码 → 块变高」的根因；旧 `activeLines` 参数仍被接受，
//    但必须**完全无效**（保留只为兼容旧调用点；⛔ 不许任何一条路径再让它生效）。
test('L1 恒定隐藏：无选区时，标记照常藏', function () {
  assert.deepStrictEqual(hidden('# 标题'), ['# ']);
  assert.deepStrictEqual(hidden('a\n# 标题\nb'), ['# ']);
});

test('L1 恒定隐藏：选区在行内（旧 activeLines 命中该行）⇒ 隐藏集合**一模一样**', function () {
  const 无选区 = marks('# 标题').ranges;
  const 行内选区 = marks('# 标题', { activeLines: [0] }).ranges;
  assert.deepStrictEqual(行内选区, 无选区, '光标/选区落在标题行也不许把 `# ` 放出来');
  assert.deepStrictEqual(hidden('# 标题', { activeLines: [0] }), ['# ']);
});

test('L1 恒定隐藏：跨行选区（两行都活动）⇒ 隐藏集合仍**一模一样**', function () {
  const src = 'a\n# 标题\nb';
  const 无选区 = marks(src).ranges;
  const 跨行选区 = marks(src, { activeLines: [0, 1, 2] }).ranges;
  assert.deepStrictEqual(跨行选区, 无选区, '选到哪一行都不改变隐藏集合（INV-LIVE-14）');
  assert.deepStrictEqual(hidden(src, { activeLines: [0, 1, 2] }), ['# ']);
});

test('强调 / 删除线：两端定界符藏掉，文字留原地', function () {
  assert.deepStrictEqual(hidden('这是 **粗体** 文本'), ['**', '**']);
  assert.deepStrictEqual(hidden('这是 *斜体* 文本'), ['*', '*']);
  assert.deepStrictEqual(hidden('这是 __粗__ 与 _斜_'), ['__', '__', '_', '_']);
  assert.deepStrictEqual(hidden('这是 ~~删~~ 文本'), ['~~', '~~']);
});

test('代码段：两端反引号藏掉（且优先于强调——`**` 在里面是内容）', function () {
  assert.deepStrictEqual(hidden('用 `code` 表示'), ['`', '`']);
  assert.deepStrictEqual(hidden('用 `**x**` 表示'), ['`', '`'], '⭐ 代码段里的 `**` ⛔ 不当强调');
});

test('链接 / 图片：藏 `[`…`](url)`，留下文字', function () {
  assert.deepStrictEqual(hidden('[文字](http://x)'), ['[', '](http://x)']);
  assert.deepStrictEqual(hidden('前 ![图](a.png) 后'), ['![', '](a.png)']);
});

test('引用：藏行首的 `>` 与一个空格', function () {
  assert.deepStrictEqual(hidden('> 引用'), ['> ']);
  assert.deepStrictEqual(hidden('>> 嵌套'), ['>> ']);
});

test('⭐⭐ 围栏内部**一个字都不动**（代码块里 `#` `**` 全是内容）', function () {
  const src = ['```rust', '# 不是标题', 'let a = **b**;', '```'].join('\n');
  // ⭐ `design/0052` U5 起：藏的是**围栏行自己**（``` ＋ 语言标记），⛔ 不是里面的内容。
  assert.deepStrictEqual(hidden(src), ['```rust', '```'], '围栏里的东西一个都不许藏');
  assert.strictEqual(marks(src).fenced, true);
});

test('围栏**外面**照常藏（状态要正确退出）', function () {
  const src = ['# 标题', '```', '原文', '```', '**后**'].join('\n');
  assert.deepStrictEqual(hidden(src), ['# ', '```', '```', '**', '**']);
});

test('`~~~` 围栏同口径', function () {
  assert.deepStrictEqual(hidden('~~~\n# x\n~~~'), ['~~~', '~~~']);
});

test('未闭合的围栏：后面全部按"里面"处理（⛔ 不在半截代码块上乱藏）', function () {
  assert.deepStrictEqual(hidden('```\n# 标题\n**粗**'), ['```'], '只有开围栏那一行被藏，里面一个字都不动');
});

// ⭐⭐ `design/0052` U5：围栏行**恒定**整行塌成 0 高（`cm-rmd-fence`）——`design/0061` L1 之后
//    不再有"活动行"特例（语言标记不可见、不可点，改语言走格式栏或 `⌘E` 原文模式）。
//    ⚠️ 只藏标记不够——空行仍占一整行高，用户看到的是「代码块上下各多一条空行」，
//    而渲染态里那两行**根本不存在**（旧的 `layoutSlack().fences` 就是在给这两行记账）。
test('⭐ 每条围栏行都进 `fenceLines`（与选区无关，旧 activeLines 被忽略）', function () {
  const src = ['```rust', 'code', '```'].join('\n');
  const 两条 = [{ line: 0, from: 0, to: 7 }, { line: 2, from: 13, to: 16 }];
  assert.deepStrictEqual(marks(src).fenceLines, 两条);
  assert.deepStrictEqual(marks(src, { activeLines: [0] }).fenceLines, 两条, '旧参数不许让开围栏行留白');
  assert.deepStrictEqual(marks(src, { activeLines: [0, 2] }).fenceLines, 两条);
  assert.deepStrictEqual(hidden(src, { activeLines: [0] }), ['```rust', '```'],
    '藏的还是围栏行自己（`to` 到行尾含换行），与活动行概念无关');
});

// ⭐⭐ `design/0052` U5 的接线：`fenceLines` 必须真的塌掉整行。
//    ⭐ `bugs/0298` 候选 1b（2026-11-12）起产品路径是 **block replace ＋ widget**
//    （`estimatedHeight = 0`），不再是 `cm-rmd-fence` 行级类——行级类只影响 DOM，
//    ⛔ 不进 CM6 的 `HeightMap`，视口外仍按一整行估算（整块长高 +20.141 px）。
//    ⚠️ 纯逻辑桩没有 `WidgetType` 时退回行级类（可见降级，不进真视图）；
//    这条退化路径由紧随其后的那条判据钉住。
test('⭐⭐ 接线：`fenceLines` 落成 block widget（区间恰是整行、`estimatedHeight = 0`，`bugs/0298` 1b）', function () {
  const f = fakeCM6({ widgetType: true });
  const field = D.createField(f.CM6, {})[0];
  const src = ['```rust', 'code', '```'].join('\n');
  const built = field.create(stateOf(src));
  const blocks = built.decos.filter(function (d) { return d.spec && d.spec.block === true; });
  assert.strictEqual(blocks.length, 2, '两条围栏行各一条 block 替换');
  assert.deepStrictEqual(blocks.map(function (d) { return [d.from, d.to]; }), [[0, 7], [13, 16]],
    '区间必须**恰好是一整行**（不吞 `\\n`）');
  assert.deepStrictEqual(blocks.map(function (d) { return src.slice(d.from, d.to); }), ['```rust', '```']);
  blocks.forEach(function (d) {
    assert.strictEqual(d.widget.estimatedHeight, 0, '视口外的高度表必须记 0（`heightForLine` 的"至少一行"被绕开）');
    assert.strictEqual(d.widget.eq({ estimatedHeight: 0 }), true);
    assert.strictEqual(d.widget.eq({ estimatedHeight: -1 }), false, '`-1` 是"回落到 lineHeight"，⛔ 不是同类');
    assert.strictEqual(d.widget.ignoreEvent(), true);
  });
  assert.deepStrictEqual(built.decos.filter(function (d) { return d.cls === 'cm-rmd-fence'; }), [],
    'block widget 落下后那一行没有 `.cm-line` ⇒ ⛔ 不许再叠行级类');
  // ⭐ L1：旧 `activeLineIndexes` 钩子仍被接受（兼容未改的调用点），但**完全无效**
  const f2 = fakeCM6({ widgetType: true });
  const field2 = D.createField(f2.CM6, { activeLineIndexes: function () { return [0]; } })[0];
  const built2 = field2.create(stateOf(src));
  assert.deepStrictEqual(built2.decos.filter(function (d) { return d.spec && d.spec.block === true; })
    .map(function (d) { return d.from; }), [0, 13], '活动行概念已删除 ⇒ 两条围栏行都必须塌');
});

test('退化：假 CM6 没有 `WidgetType` ⇒ 围栏行仍贴 `cm-rmd-fence` 行级类（与改动前逐字节相同）', function () {
  const f = fakeCM6();
  const field = D.createField(f.CM6, {})[0];
  const src = ['```rust', 'code', '```'].join('\n');
  const built = field.create(stateOf(src));
  // ⚠️ `Decoration.line` 的 spec 按类名缓存 ⇒ 造对象只发生**一次**（判据看 `decos` 里的落点）
  assert.deepStrictEqual(f.calls.line, ['cm-rmd-fence'], '两条围栏行共用同一个 spec');
  const got = built.decos.filter(function (d) { return d.cls === 'cm-rmd-fence'; });
  assert.deepStrictEqual(got.map(function (d) { return d.from; }), [0, 13], '落的是**行首偏移**，两条都要有');
  assert.deepStrictEqual(built.decos.filter(function (d) { return d.spec && d.spec.block; }), [],
    '没有 `WidgetType` 就不许造 block widget（进真视图会因缺 `coordsAt` 等原型方法炸）');
});

// ⭐⭐ `bugs/0298` 1b 的两个危险面（纯逻辑可判）：
//    ① widget 的 DOM 必须是那个 `cm-rmd-fence-block` 空 `<div>`（CSS 只压这一类）；
//    ② block widget 落下后那一行没有 `.cm-line` ⇒ 同偏移的行级类必须被跳过
//       （`bodies` / `listLines` 是唯二会落到围栏行上的两族）。
test('`bugs/0298` 1b：围栏 widget 的 DOM ＝ 带 `cm-rmd-fence-block` 的空 `<div>`', function () {
  const f = fakeCM6({ widgetType: true });
  const field = D.createField(f.CM6, {})[0];
  const built = field.create(stateOf(['```rust', 'code', '```'].join('\n')));
  const w = built.decos.filter(function (d) { return d.spec && d.spec.block; })[0].widget;
  const g = /** @type {any} */ (global);
  const prev = g.document;
  g.document = fakeDom();
  try {
    const dom = w.toDOM();
    assert.strictEqual(dom.tagName, 'DIV', 'block widget 必须是块级元素');
    assert.strictEqual(dom.className, 'cm-rmd-fence-block', '类名与 `live.css` 逐字对应');
    assert.deepStrictEqual(dom.children, [], '空元素（⛔ 不许塞占位字形）');
  } finally {
    if (prev === undefined) delete g.document;
    else g.document = prev;
  }
});

test('`bugs/0298` 1b：围栏行⛔ 不许再叠行级类（`bodies` 与 `listLines` 都要跳过）', function () {
  // ① `bodyLines: true`（块基线是标题）：`bodies` 会逐行点名，围栏行必须被跳过。
  const f1 = fakeCM6({ widgetType: true });
  const field1 = D.createField(f1.CM6, { bodyLines: true })[0];
  const b1 = field1.create(stateOf(['```rust', 'code', '```'].join('\n')));
  assert.deepStrictEqual(b1.decos.filter(function (d) {
    return d.cls === 'cm-rmd-body' && (d.from === 0 || d.from === 13);
  }), [], '围栏行没有 `.cm-line` ⇒ `cm-rmd-body` 会把 block 装饰旁边多留一行 tile');
  assert.deepStrictEqual(b1.decos.filter(function (d) {
    return d.cls === 'cm-rmd-body' && d.from === 8;
  }).map(function (d) { return d.from; }), [8], '负对照：内容行照常贴正文尺度');

  // ② 列表项里缩进写出来的围栏行：它在 `listLines` 里算**续行**，同样没有 `.cm-line`。
  const f2 = fakeCM6({ widgetType: true });
  const field2 = D.createField(f2.CM6, {})[0];
  const src = '- 甲\n\n  ```\n  x\n  ```\n';
  const plan = marks(src);
  const 围栏from = plan.fenceLines.map(function (x) { return x.from; });
  const b2 = field2.create(stateOf(src));
  assert.deepStrictEqual(b2.decos.filter(function (d) {
    return d.cls === 'cm-rmd-li' && 围栏from.indexOf(d.from) >= 0;
  }), [], '围栏行不许再拿 `cm-rmd-li`（缩进带在 block widget 上没有落点）');
  assert.ok(b2.decos.filter(function (d) { return d.spec && d.spec.block; }).length === 2,
    '两条围栏行仍是 block widget');
  // 负对照：内容行仍有列表缩进。
  assert.ok(b2.decos.some(function (d) { return d.cls === 'cm-rmd-li' && 围栏from.indexOf(d.from) < 0; }),
    '内容行的列表缩进必须还在');
});

// ⭐⭐ `bugs/0304` 候选 ④ 的接线：`zwRanges` 必须真的让反引号**脱离**零宽替换。
//    纯逻辑说"这些区间只压零宽"而没接线 ⇒ 屏幕上反引号仍被 `replace` 吞掉，
//    `cm-widgetBuffer` 照样参与断行（`Q36` 只会继续红，而单元判据看不见）。
test('接线：`cm-rmd-zw` 只落在反引号上，零宽替换不再盖住它们（`bugs/0304` ④）', function () {
  const f = fakeCM6();
  const field = D.createField(f.CM6, {})[0];
  const src = '[`a`](u)';
  const built = field.create(stateOf(src));
  const zw = built.decos.filter(function (d) { return d.cls === 'cm-rmd-zw'; });
  assert.deepStrictEqual(zw.map(function (d) { return [d.from, d.to]; }), [[1, 2], [3, 4]],
    '两个反引号各一条 mark（字符留在字符流里）');
  const replaces = built.decos.filter(function (d) { return d.kind === 'replace'; });
  zw.forEach(function (z) {
    assert.ok(!replaces.some(function (d) { return d.from < z.to && z.from < d.to; }),
      '反引号区间⛔ 仍在零宽替换里（那会再插一个 `cm-widgetBuffer`）');
  });
  // 被拆之后，隐藏与零宽的并集**恰好**等于 plan.ranges（一个字符都不许多藏/少藏）。
  /** @param {Array<[number,number]>} xs */
  function 合并(xs) {
    const out = xs.slice().sort(function (a, b) { return a[0] - b[0]; });
    /** @type {Array<[number,number]>} */
    const r = [];
    out.forEach(function (x) {
      const last = r[r.length - 1];
      if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
      else r.push([x[0], x[1]]);
    });
    return r;
  }
  const ranges = marks(src).ranges;
  const 覆盖 = 合并([].concat(
    replaces.map(function (d) { return [d.from, d.to]; }),
    zw.map(function (d) { return [d.from, d.to]; })
  ));
  assert.deepStrictEqual(覆盖, ranges.map(function (r) { return [r.from, r.to]; }),
    '拆出来的零宽 mark 与剩余零宽替换必须拼回原来的隐藏集合');
});

// ⭐ fail-closed（`bugs/0304` §5 候选 ④ 的硬要求）：`plan.zwRanges` 缺失 / 为空时，
//    `build()` 必须**完全**退回改动前的 `plan.ranges.map(hide.range)`。
test('fail-closed：`plan.zwRanges` 缺失 ⇒ 全部走零宽替换，与改动前逐字节相同', function () {
  const DECO = require('fs').readFileSync(require('path').join(__dirname, '../../src/live/decorations.js'), 'utf8');
  const 锚 = '      zwRanges: zwRanges,';
  const mut = DECO.replace(锚, '');
  assert.notStrictEqual(mut, DECO, 'fail-closed 变异没改到');
  const src = '（`blocks.rs`';
  const f = fakeCM6();
  const field = loadModules(mut).createField(f.CM6, {})[0];
  const built = field.create(stateOf(src));
  assert.deepStrictEqual(built.decos.filter(function (d) { return d.kind === 'replace'; })
    .map(function (d) { return [d.from, d.to]; }),
  [[1, 2], [11, 12]], '缺失 `zwRanges` ⇒ 只有 `plan.ranges` 那两条零宽替换');
  assert.deepStrictEqual(built.decos.filter(function (d) { return d.cls === 'cm-rmd-zw'; }), [],
    '缺失 `zwRanges` ⇒ 一条 `cm-rmd-zw` 都不许有（与改动前逐字节相同）');
  // 负对照：产品版把同样两条改成了零宽 mark。
  const good = D.createField(fakeCM6().CM6, {})[0].create(stateOf(src));
  assert.deepStrictEqual(good.decos.filter(function (d) { return d.cls === 'cm-rmd-zw'; })
    .map(function (d) { return [d.from, d.to]; }), [[1, 2], [11, 12]], '产品版走 `cm-rmd-zw`');
});

// ⭐ 变异 m24（`tests.md`：没做过变异测试的断言不算数）：把 zw 拆分整段去掉 ⇒
//    上面那条接线判据必须红（反引号仍被零宽替换吞掉）。
test('变异 m24：不拆 zw（整段退回零宽替换）⇒ `cm-rmd-zw` 一条都不产，接线判据必红', function () {
  const DECO = require('fs').readFileSync(require('path').join(__dirname, '../../src/live/decorations.js'), 'utf8');
  const 起 = DECO.indexOf('      const zwRanges = Array.isArray(plan.zwRanges)');
  const 末 = DECO.indexOf('      // ⭐ **行内呈现**', 起);
  assert.ok(起 >= 0 && 末 > 起, 'm24 没找到拆分那一段');
  const mut = DECO.slice(0, 起) + DECO.slice(末);
  const f = fakeCM6();
  const field = loadModules(mut).createField(f.CM6, {})[0];
  const built = field.create(stateOf('[`a`](u)'));
  assert.deepStrictEqual(built.decos.filter(function (d) { return d.cls === 'cm-rmd-zw'; }), [],
    'm24 没红：拆分段还在');
  assert.deepStrictEqual(D.createField(fakeCM6().CM6, {})[0].create(stateOf('[`a`](u)'))
    .decos.filter(function (d) { return d.cls === 'cm-rmd-zw'; }).map(function (d) { return d.from; }),
  [1, 3], '负对照：产品版两个反引号各一条 mark');
});

test('多行偏移：第二行的区间是**绝对偏移**（⛔ 不是行内相对）', function () {
  const src = 'a\n**b**';
  const r = marks(src).ranges;
  assert.deepStrictEqual(r, [
    { from: 2, to: 4 },
    { from: 5, to: 7 },
  ]);
});

test('区间永远是合法的（`from < to` 且落在文本内）——`Decoration` 越界会整块白屏', function () {
  const samples = ['', '\n', '# ', '**', '[', '(](', '~~~~', '*', '_x', '`', '> > ', '#\n## 二',
    '#', '##', '######', '> ##', '##\n'];   // ⚠️ 末行无尾换行的裸井号：多藏一个就越界
  for (const s of samples) {
    const rs = marks(s).ranges;
    for (const r of rs) {
      assert.ok(r.from >= 0 && r.to <= s.length && r.to > r.from, JSON.stringify(s) + ' 产出非法区间 ' + JSON.stringify(r));
    }
  }
});

test('`fenceOf`：三种围栏写法', function () {
  assert.strictEqual(D.fenceOf('```js'), '`');
  assert.strictEqual(D.fenceOf('  ~~~~'), '~');
  assert.strictEqual(D.fenceOf('正文'), null);
});

// ⭐⭐ 接线：`createField` 交出去的东西必须**同时**含 StateField 与那个 facet。
//    ⚠️ 2026-10-26 的真缺陷：只返回 `StateField` ⇒ CM6 **一个装饰都不采纳**，
//    `markers()` 算得出区间、屏幕上却全是 `#` / `**` / 反引号，而**任何逻辑判据都看不见**
//    （`block-harness.js` 的 `隐藏区间=8` 与 `块内文本` 里原文并存，就是那次取证）。
function fakeCM6(opts) {
  const o = opts || {};
  const calls = { from: 0, fromArg: null, line: [], widget: [], replace: [], mark: [] };
  const CM6 = {
    Decoration: {
      // ⭐ `bugs/0298` 1b：block 替换的 spec 要能被判据读到（`block` / `widget`）。
      // ⭐ `bugs/0304` ④：`replace` 的产物带 `kind: 'replace'`，`mark` 的产物带
      //    `cls` ＋ `kind: 'mark'`——两者都是零宽/行内装饰，判据要能分清。
      replace: function (spec) {
        calls.replace.push(spec);
        return {
          spec: spec,
          range: function (from, to) {
            /** @type {any} */
            const d = { from: from, to: to, kind: 'replace', spec: spec };
            // 真 CM6 的 `PointDecoration` 把 widget 挂在装饰上（`deco.widget`）；
            // 桩也照此暴露，判据才测得到 `estimatedHeight`。
            if (spec && spec.widget) d.widget = spec.widget;
            return d;
          },
        };
      },
      // ⭐ `bugs/0304` 候选 ④：行内代码反引号的 `cm-rmd-zw` 走 `Decoration.mark`。
      mark: function (spec) {
        calls.mark.push(spec.class);
        return {
          cls: spec.class,
          range: function (from, to) {
            return { from: from, to: to, cls: spec.class, kind: 'mark' };
          },
        };
      },
      // ⭐ 行级品种类（`bugs/0015`）：`Decoration.line` 的 spec 只有 `class`，
      //    `.range(from)` 落的是**行首偏移**。⚠️ 这里记下每次的类名，判据要按顺序核对。
      line: function (spec) {
        calls.line.push(spec.class);
        return {
          cls: spec.class,
          range: function (from) { return { from: from, to: from, cls: spec.class }; },
        };
      },
      // ⭐ 任务框 widget（`bugs/0092`）：`.range(pos)` 落在正文起点。
      widget: function (spec) {
        calls.widget.push(spec.widget);
        return { range: function (pos) { return { from: pos, to: pos, widget: spec.widget }; } };
      },
      set: function (decos) { return { size: decos.length, decos: decos }; },
    },
    // ⚠️ 让 `define` 原样返回那份 spec：判据要能直接调 `create` / `update`。
    StateField: { define: function (spec) { return spec; } },
    // ⭐ `design/0052` U3：**树的唯一来源**。⚠️ 这两条必须存在且回真树——
    //    `markers()` 现在的唯一判据就是树，"树空 ⇒ 什么都不藏"。
    //    假 CM6 若不给它，这一整份判据会**看起来全绿却什么都没验**（所有区间恒空）。
    syntaxTree: function (state) { return (state && state.tree) || null; },
    ensureSyntaxTree: function (state) { return (state && state.tree) || null; },
    EditorView: {
      decorations: {
        from: function (f) { calls.from++; calls.fromArg = f; return { facetFrom: f }; },
      },
    },
  };
  // ⭐ `bugs/0298` 1b：只在显式要求时提供 `WidgetType` 基类。
  //    ⚠️ 缺省**不提供**——那是产品路径之外的老口径（`cm-rmd-fence` 行级类），
  //    既有判据靠它验证"退化路径与改动前一致"。真 CM6 永远有 `WidgetType`。
  if (o.widgetType === true) {
    CM6.WidgetType = class {
      get estimatedHeight() { return -1; }
      get lineBreaks() { return 0; }
    };
  }
  return { calls: calls, CM6: CM6 };
}
/**
 * 假的 `EditorState`。
 * `tree` **显式传 `null`** ＝"解析器还没跑完"（`ensureSyntaxTree` 超时的那种首帧）。
 * ⚠️ 第二参 `active` 只为兼容既有调用点的位置参数，**不再进状态对象**——
 *    `design/0061` L1 之后没有任何产品路径读它（读到就是"活动行"复活）。
 */
function stateOf(text, active, tree) {
  void active;
  return {
    doc: { toString: function () { return text; } },
    tree: tree === undefined ? parse(text) : tree,
  };
}

test('⭐⭐ 接线：StateField 必须接到 `EditorView.decorations`（漏了就是"标记一个都藏不掉"）', function () {
  const f = fakeCM6();
  const ext = D.createField(f.CM6, {});
  assert.ok(Array.isArray(ext), '返回的必须是数组（调用方 `extensions.push(...)` 一次就够）');
  assert.strictEqual(ext.length, 2);
  assert.strictEqual(f.calls.from, 1, '`EditorView.decorations.from` 必须被调**恰好一次**');
  assert.strictEqual(f.calls.fromArg, ext[0], '接的必须是**同一个** field（⛔ 另建一份）');
  assert.strictEqual(ext[1].facetFrom, ext[0], '第二项必须是该 field 的 facet provider');
});

test('装饰集来自 `markers()`；**选区变化不重算**（L1），文档变了才重算，都没变就原值返回', function () {
  const f = fakeCM6();
  const ext = D.createField(f.CM6, {});
  const field = ext[0];
  const built = field.create(stateOf('# 标题'));
  // ⚠️ **2** 条：① 标题的隐藏区间（`# `）② 行级品种类 `cm-rmd-h1`（`bugs/0015`）。
  assert.strictEqual(built.size, 2, '标题：1 个隐藏区间 ＋ 1 条行级品种类');
  // ⭐ L1：选区怎么变都不许重建 —— 重建就会把源码放回屏幕（INV-LIVE-14）
  const 选区变了 = field.update(built, { docChanged: false, selection: {}, state: stateOf('# 标题', [0]) });
  assert.strictEqual(选区变了, built, '选区变化必须返回**原对象**（⛔ 重算隐藏区间）');
  // ⚠️ 文档变了 ⇒ 必须重算（否则改完还按旧区间藏）
  const 文档变了 = field.update(built, { docChanged: true, selection: null, state: stateOf('## 标题') });
  assert.notStrictEqual(文档变了, built);
  assert.deepStrictEqual({ from: 文档变了.decos[0].from, to: 文档变了.decos[0].to }, { from: 0, to: 3 }, '`## ` 按新源码藏');
  // ⚠️ 什么都没变 ⇒ 必须返回**原对象**（⛔ 每帧重建整块装饰）
  const same = field.update(built, { docChanged: false, selection: null, state: stateOf('# 标题') });
  assert.strictEqual(same, built);
});

// ⭐⭐ `design/0052` U3 的第二个触发条件：**后台解析完成**。
//    ⚠️ 实测出来的坑：CM6 的 Markdown 解析是分片的，首帧 `ensureSyntaxTree` 常常超时 ⇒
//    那一刻树是空的 ⇒ 一个标记都藏不掉。解析器跑完后派的是 `Language.setState` 的**效果事务**
//    ——⛔ 既没有 `docChanged` 也没有 `selection` ⇒ 只判那两个条件的话，
//    **首帧没藏掉的标记永远留在屏幕上**，而任何判据都看不见。
function 树换了的假事务(前, 后) {
  return { docChanged: false, selection: null, startState: 前, state: 后 };
}

test('⭐⭐ 后台解析完成（树换了对象）也要重算，⛔ 不能只等 `docChanged` / `selection`', function () {
  const f = fakeCM6();
  const field = D.createField(f.CM6, {})[0];
  // 首帧：解析器还没跑完 ⇒ 可见降级（屏幕上看得见 `#`）
  const 未解析 = field.create(stateOf('# 标题', [], null));
  assert.strictEqual(未解析.size, 0, '没有树 ⇒ 一个区间、一条行级品种类都没有');
  // 解析完成 ⇒ 同一份文档、同一份选区，只是树换了
  const 解析完 = field.update(未解析, 树换了的假事务(stateOf('# 标题', [], null), stateOf('# 标题')));
  assert.strictEqual(解析完.size, 2, '树换了 ⇒ 隐藏区间 ＋ 标题行级品种类都回来');
  assert.deepStrictEqual({ from: 解析完.decos[0].from, to: 解析完.decos[0].to }, { from: 0, to: 2 }, '`# ` 必须真的藏掉');
  // ⚠️ 反面：树**没换**（同一个对象）⇒ 必须返回原值，⛔ 每帧重建
  const t = parse('# 标题');
  const 没换 = field.update(解析完, 树换了的假事务(stateOf('# 标题', [], t), stateOf('# 标题', [], t)));
  assert.strictEqual(没换, 解析完);
  // ⚠️ 反面：`tr.startState` 缺省（假 CM6 的老形状）⇒ 这条判据不参与，⛔ 不许当成"树变了"
  const 无前态 = field.update(解析完, { docChanged: false, selection: null, state: stateOf('# 标题') });
  assert.strictEqual(无前态, 解析完);
});

// ⭐⭐ 行级排版（`bugs/0015`）：用户报「从标题行按 Enter 进入下一行后，下面一行一直是标题状态」。
//    ⚠️ 根因不在 `markers()` 的隐藏区间上——它一条都没错——而在**尺度是块级搬过去的**
//    （`live/box.js` 量被换掉的那一个元素）⇒ 块里长出来的每一行都继承 28px/700。
//    ⇒ 判据必须落在"**哪一行该是标题**"这个纯逻辑上，否则只能靠肉眼。
test('⭐⭐ 行级品种类：`#` 起头的行才是标题，其余行不带（`bugs/0015`）', function () {
  const p = marks('# 标题\n正文一行\n## 二级');
  assert.deepStrictEqual(p.headings, [
    { line: 0, level: 1, from: 0 },
    { line: 2, level: 2, from: 10 },  // `# 标题` 4 ＋ `\n` ＋ `正文一行` 4 ＋ `\n`
  ]);
  assert.deepStrictEqual(p.bodies, [], '没要 `bodyLines` 就不产出回落行（段落/引用/代码块不需要）');
});

test('⭐⭐ 回落行：块基线是标题尺度时，非标题行逐行都要带上（含围栏与围栏内部）', function () {
  const p = marks('## 标题\n正文\n```\ncode\n```', { bodyLines: true });
  assert.deepStrictEqual(p.headings.map(function (h) { return h.line; }), [0]);
  assert.deepStrictEqual(p.bodies.map(function (b) { return b.line; }), [1, 2, 3, 4],
    '正文行、两条围栏行、围栏里的代码行**都不是标题**');
  assert.deepStrictEqual(p.bodies.map(function (b) { return b.from; }), [6, 9, 13, 18]);
});

test('⭐ 行级品种类与隐藏集合**互不影响**：旧 activeLines 也不改变任何一类', function () {
  const p = marks('## 标题\n正文', { activeLines: [0, 1], bodyLines: true });
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 3 }], '两行都"活动"也照藏（L1 恒定）');
  assert.deepStrictEqual(p.headings.map(function (h) { return h.level; }), [2]);
  assert.deepStrictEqual(p.bodies.map(function (b) { return b.line; }), [1]);
});

test('引用里的标题：认得出级别（`> ## x`），且回落的行不带引用前缀的字面', function () {
  const p = marks('> ## 引用里的标题\n> 正文', { bodyLines: true });
  assert.deepStrictEqual(p.headings, [{ line: 0, level: 2, from: 0 }]);
  assert.deepStrictEqual(p.bodies.map(function (b) { return b.line; }), [1]);
});

// ⭐⭐ 2026-10-27 由 `probe-live-block` 的 O 段 oracle 抓出来的**静默分歧**：
//    `HEADING` 原先是 `/^(#{1,6})[ \t]+/`（必须有空格）⇒ 一行只有 `##` 时编辑态按**正文**
//    14px 显示，而同一份源码在渲染态是**空 h2**（`rmd probe --file` 实测 comrak 报 `h2 L1`）。
//    它不是"边角到不可能发生"：删标题标记时那一瞬间就是这个状态，而 `bugs/0015` 正是同一族。
test('⭐ 只有井号的行也是标题（CommonMark 空 ATX，comrak 实测认成 h2）', function () {
  const p = marks('##\n正文', { bodyLines: true });
  assert.deepStrictEqual(p.headings, [{ line: 0, level: 2, from: 0 }], '`##` 是 h2，⛔ 不是正文');
  assert.deepStrictEqual(p.bodies.map(function (b) { return b.line; }), [1], '第二行才是正文');
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 2 }], '只藏井号本身：⛔ 不许藏到行尾之外');
});

test('⭐⭐ 接线：`bodyLines` 必须真的把行级品种类交给装饰集（纯逻辑对、没接线等于没修）', function () {
  const f = fakeCM6();
  const hooks = { bodyLines: true };
  const field = D.createField(f.CM6, hooks)[0];
  const built = field.create(stateOf('## 标题\n正文'));
  assert.deepStrictEqual(f.calls.line, ['cm-rmd-h2', 'cm-rmd-body'], '两条行级品种类都要被建出来');
  const cls = built.decos.filter(function (d) { return d.cls; }).map(function (d) { return d.cls; });
  assert.deepStrictEqual(cls, ['cm-rmd-h2', 'cm-rmd-body']);
  // ⚠️ 块基线不是标题（段落 / 引用 / 代码块）⇒ 非标题行**不加**回落类，⛔ 别把正文也钉死
  const f2 = fakeCM6();
  const field2 = D.createField(f2.CM6, {})[0];
  field2.create(stateOf('正文\n第二行'));
  assert.deepStrictEqual(f2.calls.line, [], '段落块不产出行级品种类');
});

// ⭐ 几何闸门的**允许量**（`main.js::slack`）：算得出来的"源码结构性差"，⛔ 不是魔法容差。
// ⚠️ 三类各自独立计数（`docs/bugs/0025`）：围栏 / 只有引用标记的空行 / **连续的正文本行**。
//    `softWraps` 是第三类——CommonMark 把软换行合并成一个段落（`a\nb` 渲染成一行 `<p>`），
//    编辑态却是两行 ⇒ 每多一行多占一整行。2026-10-27 之前没有它，表现是
//    **两行以上的段落点不进去**（「这一块的高度对不上」）。
test('`layoutSlack`：围栏行**不再计数**（U5 起它们塌成 0 高），**围栏内部**的空行是真内容（不算）', function () {
  assert.deepStrictEqual(D.layoutSlack('# 标题'), { fences: 0, blanks: 0, softWraps: 0 });
  // ⚠️ `fences` 恒 0（`design/0052` U5）：两条围栏行由 `cm-rmd-fence` 整行塌掉，
  //    渲染态里本来就不存在那两行 ⇒ 几何上不再有这一笔差额。
  //    ⛔ 若哪天塌行失效，`B-3b` 会以"块高了 40 px"的形式红 —— 别把这里改回 2。
  assert.deepStrictEqual(D.layoutSlack('```rust\nfn a() {}\n\nfn b() {}\n```'),
    { fences: 0, blanks: 0, softWraps: 0 }, '代码块里的空行就是一行代码，⛔ 不是段间距');
  assert.deepStrictEqual(D.layoutSlack('> 第一段\n>\n> 第二段'), { fences: 0, blanks: 1, softWraps: 0 },
    '只剩 `>` 的行在渲染态里是段落分隔');
  assert.deepStrictEqual(D.layoutSlack('a\n\nb'), { fences: 0, blanks: 1, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack(''), { fences: 0, blanks: 0, softWraps: 0 });
});

// ⭐ `softWraps`（`bugs/0025`）：**连续正文行**才合并；标题、列表项、围栏断开连续段。
test('`layoutSlack`：连续正文本行被合并成一段 ⇒ 每多一行多占一行（`softWraps`）', function () {
  assert.deepStrictEqual(D.layoutSlack('普通段落\n第二行'), { fences: 0, blanks: 0, softWraps: 1 });
  assert.deepStrictEqual(D.layoutSlack('一\n二\n三'), { fences: 0, blanks: 0, softWraps: 2 });
  // 单行段落没有任何合并差。
  assert.deepStrictEqual(D.layoutSlack('只有一行'), { fences: 0, blanks: 0, softWraps: 0 });
  // 标题自成一块，⛔ 不与正文合并。
  assert.deepStrictEqual(D.layoutSlack('# 标题\n正文'), { fences: 0, blanks: 0, softWraps: 0 });
  // 列表项各自是 `<li>`，⛔ 不合并。
  assert.deepStrictEqual(D.layoutSlack('- 甲\n- 乙\n- 丙'), { fences: 0, blanks: 0, softWraps: 0 });
  assert.deepStrictEqual(D.layoutSlack('1. 甲\n2. 乙'), { fences: 0, blanks: 0, softWraps: 0 });
  // 空行把两段断开 ⇒ 各段各算（每段只有一行 ⇒ 0）。
  assert.deepStrictEqual(D.layoutSlack('甲\n\n乙\n丙'), { fences: 0, blanks: 1, softWraps: 1 });
  // 引用里的软换行同样合并（`> a\n> b` 是一个引用段落）。
  assert.deepStrictEqual(D.layoutSlack('> 甲\n> 乙'), { fences: 0, blanks: 0, softWraps: 1 });
});

// ⭐⭐ **单元格上下文**（`design/0049` ＋ 2026-10-28 评审 P2-③）：GFM 的格子内**只有行内语义**。
//    格子是从全文里切出来**单独**解析的 ⇒ 没有这一层，`# 普通格子` 在树里是 `ATXHeading1`，
//    装饰层照块级规则贴 `cm-rmd-h1`，点进格子字号/行高当场变掉，而阅读态 `<td>` 里它就是文字。
//    ⚠️ 判据是"节点在树里的位置"，⛔ 不是"内容里有没有 `#`"。
test('`cellContext`：格子里 ⛔ 没有块级标题（`# 普通格子` 就是七个字）', function () {
  assert.deepStrictEqual(marks('# 普通格子').headings.map(function (h) { return h.level; }), [1],
    '没有这个开关时照块级规则走（回归：块编辑⛔ 不许跟着变）');
  assert.deepStrictEqual(hidden('# 普通格子'), ['# ']);
  const cell = marks('# 普通格子', { cellContext: true });
  assert.deepStrictEqual(cell.headings, [], '格子里不认标题');
  assert.deepStrictEqual(cell.ranges, [], '`#` 是**内容**，⛔ 不藏');
});

test('`cellContext`：引用 / 列表 / 围栏的标记同样⛔ 不藏，行级品种类一个都不产', function () {
  assert.deepStrictEqual(hidden('> 引用', { cellContext: true }), [], '格子里 `>` 是普通文字');
  assert.deepStrictEqual(hidden('- 甲', { cellContext: true }), [], '本来就不藏 ListMark');
  const fence = marks('```rust', { cellContext: true });
  assert.deepStrictEqual(fence.ranges, [], '围栏符是内容 ⇒ 不藏');
  assert.deepStrictEqual(fence.fenceLines, [], '⛔ 不许把这一行塌成 0 高（阅读态它占一行）');
  assert.deepStrictEqual(marks('```rust').fenceLines.length, 1, '块编辑那边照旧塌（回归）');
});

test('`cellContext`：**行内**语义照旧——强调 / 删除线 / 行内代码 / 链接', function () {
  assert.deepStrictEqual(hidden('**粗**', { cellContext: true }), ['**', '**']);
  assert.deepStrictEqual(
    marks('**粗**', { cellContext: true }).inline.filter(function (m) { return m.cls === 'cm-rmd-strong'; }).length,
    1, '行内呈现照贴（渲染态 `<td>` 里也是粗体）');
  assert.deepStrictEqual(hidden('~~删~~', { cellContext: true }), ['~~', '~~']);
  assert.deepStrictEqual(hidden('`码`', { cellContext: true }), ['`', '`']);
});

test('`cellContext`：块级外壳被误判时，**行内标记仍然照常**（`# **粗**` ≠ "整行不认"）', function () {
  // `# **粗**` 在格子里渲染成 `<td># <strong>粗</strong></td>` ⇒ `#` 留在屏幕上、
  // `**` 该藏。⚠️ 这正是"只按最外层块名一刀切"做不到的那一条。
  assert.deepStrictEqual(hidden('# **粗**', { cellContext: true }), ['**', '**']);
});

// ⭐⭐ 2026-11-05（`bugs/0092`）：用户报「点进列表项之后，还是显示 `- ` 原文，画面跳动」。
//    根因是 `ListMark` / `TaskMarker` 被**有意**排除在 `HIDDEN_MARK` 之外（旧注释只算了
//    "藏了会变矮"），代价是标记占正文宽度 ⇒ 长条目多折一行、整块变高。
//    ⇒ 现在：标记与行首缩进一并藏掉；圆点/编号/方框由行级装饰画在**缩进带**里。
test('列表：`- ` / `1. ` 与行首缩进一并藏掉，⛔ 不再占正文宽度（`bugs/0092`）', function () {
  assert.deepStrictEqual(hidden('- 甲'), ['- ']);
  assert.deepStrictEqual(hidden('* 甲'), ['* ']);
  assert.deepStrictEqual(hidden('1. 甲'), ['1. ']);
  assert.deepStrictEqual(hidden('  - 嵌套'), ['  - '], '行首缩进也藏（嵌套缩进由行级 padding 给）');
  assert.deepStrictEqual(hidden('> - 引用内'), ['> - '], '引用前缀与列表标记连成一整段');
  assert.deepStrictEqual(hidden('正文'), [], '普通段落一个字都不藏（回归）');
});

test('列表：`listLines` 给出每行的深度与品种，续行同样有深度（`bugs/0092`）', function () {
  const p = marks('1. 第一\n   - 嵌套\n     1. 三级\n   - 第二\n');
  assert.deepStrictEqual(p.listLines.map(function (l) { return [l.line, l.depth, l.kind]; }),
    [[0, 0, 'ordered'], [1, 1, 'bullet'], [2, 2, 'ordered'], [3, 1, 'bullet']]);
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.from; }), [0, 6, 14, 25],
    '`from` 是行首偏移（喂 `Decoration.line`）');
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.contentFrom; }), [3, 11, 22, 30],
    '`contentFrom` 是正文起点（标记与行首缩进都藏完之后；喂 `listContentStart`）');
  const 续 = marks('- 甲\n  - 乙\n    续行文本\n');
  assert.deepStrictEqual(续.listLines.map(function (l) { return [l.line, l.depth, l.kind]; }),
    [[0, 0, 'bullet'], [1, 1, 'bullet'], [2, 1, 'plain']], '续行没有标记，但缩进层级照旧');
});

// ⭐⭐ `bugs/0321` ①（2026-11-14 用户报告）：「编辑的时候 List Item 是圆点，编辑完展示的时候，
//    变成空心圈 / 实心方，不一样了。编辑的时候就要变，而不是等到展示的时候变。」
//    阅读态的圆点是 **UA 级联**画的（`typography.css` 刻意⛔ 不覆盖 `list-style-type`）：
//    `ul` 实心圆 → `ul ul` 空心圈 → `ul ul ul` 及更深实心方。⇒ 编辑态按**同一个层数**给形状。
//    ⚠️ 层数 ≠ `depth`：`depth` 是"行盒该缩进几格"，含两处**补位**（引用宿主 / 段落宿主，见下一条）。
test('列表层级 `level`：圆点形状按**嵌套层数**给，⛔ 不跟 `depth` 的补位走（`bugs/0321`）', function () {
  const 四级 = marks('- 一\n  - 二\n    - 三\n      - 四\n');
  assert.deepStrictEqual(四级.listLines.map(function (l) { return l.level; }), [0, 1, 2, 3],
    '最外层是 0（⛔ 不是 1：`listStack.length` 是"外层已有几个"）');
  assert.deepStrictEqual(四级.listLines.map(function (l) { return D.bulletShape(l.level); }),
    ['disc', 'circle', 'square', 'square'], '与阅读态 UA 级联逐层对应');
  // 引用里的列表：`depth` 要 +1（宿主没搬内层 `<ul>` 的缩进），但它仍是**第一层**列表 ⇒ 实心圆。
  const 引用 = marks('> - 甲\n');
  assert.deepStrictEqual([引用.listLines[0].depth, 引用.listLines[0].level], [1, 0],
    '形状只认层数：引用里的第一层列表不许变成空心圈');
  // 段落宿主同样：`depth` +1、`level` 不变。
  const 宿主 = D.markers('- 甲\n  - 乙\n', { listHost: false, tree: parse('- 甲\n  - 乙\n') });
  assert.deepStrictEqual(宿主.listLines.map(function (l) { return [l.depth, l.level]; }),
    [[1, 0], [2, 1]], '补位只动 `depth`');
  // 混排（有序里套无序）按**列表嵌套**算层，⛔ 不按"第几个 `<li>`"。
  assert.deepStrictEqual(marks('1. 甲\n   - 乙\n').listLines.map(function (l) { return l.level; }),
    [0, 1], '有序项里的第一个无序项是第二层');
  assert.strictEqual(D.bulletShape(undefined), 'disc', '缺省 / 非法值按最外层');
  assert.strictEqual(D.bulletShape(9), 'square', '三级及更深恒为实心方');
});

// ⭐⭐ `bugs/0321` ②（2026-11-14 用户报告）：「进入编辑状态的缩进，和展示的缩进是不一样的。
//    违背展示和编辑完全一致的原则。」——用户按 `Tab` 之后源码长成 `1. 甲` / `   2. 乙`，
//    而 CommonMark §5.2 规定**打断段落**的有序项必须从 `1` 起 ⇒ comrak 渲染成
//    `<li>甲<br />2. 乙</li>`（**那一行是段落正文**）。Lezer 不守这条，树里是嵌套列表
//    ⇒ 编辑侧照子项画缩进与编号，阅读侧是同一段里的第二行字。
//    ⇒ 编辑侧以**树**为准跳过这种"假嵌套"，由外层列表的 `lineDepth` 兜住（与阅读态同起点）。
test('假嵌套有序列表按**正文**显示（CommonMark §5.2，`bugs/0321` 第二半）', function () {
  const 用户 = '1. 甲\n   2. 乙\n';
  const p = marks(用户);
  assert.deepStrictEqual(p.listLines.map(function (l) { return [l.line, l.kind, l.depth, l.level]; }),
    [[0, 'ordered', 0, 0], [1, 'plain', 0, 0]],
    '第二行是外层列表的**续行**（⛔ 不是子项：comrak 里它是上一项正文）');
  assert.deepStrictEqual(hidden(用户), ['1. ', '   '], '三个空格照常藏（续行的行首缩进）');
  assert.strictEqual(p.listLines[1].contentFrom, 8, '正文落在外层列表的内容列上（与阅读态同一起点）');

  // 中间隔了空行 ⇒ comrak 认这个列表（`<ol start="2">`）⇒ 编辑侧同样认（负对照）。
  const 留空 = '1. 甲\n\n   2. 乙\n';
  assert.deepStrictEqual(marks(留空).listLines.map(function (l) { return [l.line, l.kind, l.depth]; }),
    [[0, 'ordered', 0], [1, 'plain', 0], [2, 'ordered', 1]], '空行之后是真嵌套');
  // 编号已经是 `1` ⇒ 不打断段落（`1. 甲\n   1. 乙` 在两个解析器里都是真嵌套）。
  assert.deepStrictEqual(marks('1. 甲\n   1. 乙\n').listLines.map(function (l) { return l.kind; }),
    ['ordered', 'ordered']);
  // 负对照 ①：`- 甲\n  2. 乙` 在 comrak 里同样是**正文**（无序项没有打断规则，有序行仍被吞）。
  assert.deepStrictEqual(marks('- 甲\n  2. 乙\n').listLines.map(function (l) { return l.kind; }),
    ['bullet', 'plain']);
  // 负对照 ②：无序项 / 二级无序项**不受**这条规则影响。
  assert.deepStrictEqual(marks('1. 甲\n   - 乙\n').listLines.map(function (l) { return l.kind; }),
    ['ordered', 'bullet']);
  // 负对照 ③：同一列表里的第二个有序项（`1. 甲\n   1. 乙\n   5. 丙`）——`5.` 打断的是**列表项**，
  //   不是段落 ⇒ 仍是那一层的第二项（渲染编号由位置算，见上一条 test）。
  assert.deepStrictEqual(marks('1. 甲\n   1. 乙\n   5. 丙\n').listLines
    .map(function (l) { return [l.kind, l.depth]; }),
  [['ordered', 0], ['ordered', 1], ['ordered', 1]]);
});

// ── 变异自检（上面两组判据的负向证据）─────────────────────────────────────
//
// `.claude/rules/tests.md`：没做过变异测试的断言不算数。每条都加载**真实源码的变异副本**
// （`vm` 里跑，⛔ 不改 `src/`），并各带一条负对照。
function 变异副本(target, replacement) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const src = fs.readFileSync(require.resolve('../../src/live/decorations.js'), 'utf8');
  assert.strictEqual(src.split(target).length - 1, 1, '变异必须恰好命中一处：' + target);
  // ⚠️ 产品里 `liveGeometry` 先于本文件加载（`index.html` 的脚本顺序）；
  //    隔离上下文里也要给同一个依赖，否则进列表分支就抛"必须先于…加载"。
  const box = {
    module: { exports: {} },
    window: { rmd: { liveGeometry: require('../../src/live/geometry.js') } },
  };
  vm.runInNewContext(src.replace(target, replacement), box);
  return box.module.exports;
}

test('`bugs/0321` 变异：空心圈被画回实心圆 ⇒ 层级判据必红、外层与方形负对照仍绿', function () {
  const bad = 变异副本("return 层 === 1 ? 'circle' : 'square';", "return 层 === 1 ? 'disc' : 'square';");
  assert.strictEqual(bad.bulletShape(1), 'disc', '变异后第二层退回实心圆（用户报的那个形态）');
  assert.throws(function () {
    assert.strictEqual(bad.bulletShape(1), 'circle');
  }, { code: 'ERR_ASSERTION' }, '第二层空心圈的判据必须当场红');
  assert.strictEqual(bad.bulletShape(0), 'disc', '负对照：第一层本来就是实心圆');
  assert.strictEqual(bad.bulletShape(3), 'square', '负对照：三层及更深恒为实心方');
});

test('`bugs/0321` 变异：假嵌套跳过被摘掉 ⇒ `1. 甲\\n   2. 乙` 重新被画成子项（判据必红）', function () {
  const bad = 变异副本(
    'if (name === \'OrderedList\' && 假嵌套列表(node.node)) return false;',
    'if (false) return false;');
  const 用户 = '1. 甲\n   2. 乙\n';
  const p = bad.markers(用户, { tree: parse(用户) });
  // ⚠️ 变异副本在另一个 vm realm 里 ⇒ `deepStrictEqual` 会因原型不同假红，逐值串比。
  assert.strictEqual(JSON.stringify(p.listLines.map(function (l) { return [l.kind, l.depth]; })),
    JSON.stringify([['ordered', 0], ['ordered', 1]]), '变异后编辑侧又把它画成子项（与 comrak 不一致）');
  assert.throws(function () {
    assert.strictEqual(p.listLines[1].kind, 'plain');
  }, { code: 'ERR_ASSERTION' }, '"按正文显示"的判据必须当场红');
  // 负对照：空行隔开的真嵌套 / 有序项里的无序子项都不受这条分支影响。
  const 留空 = '1. 甲\n\n   2. 乙\n';
  assert.strictEqual(JSON.stringify(bad.markers(留空, { tree: parse(留空) }).listLines
    .map(function (l) { return [l.line, l.kind]; })),
  JSON.stringify([[0, 'ordered'], [1, 'plain'], [2, 'ordered']]), '空行之后仍是真嵌套');
  const 混合 = '1. 甲\n   - 乙\n';
  assert.strictEqual(JSON.stringify(bad.markers(混合, { tree: parse(混合) }).listLines
    .map(function (l) { return l.kind; })), JSON.stringify(['ordered', 'bullet']), '无序子项照旧');
});

// ⭐⭐ `bugs/0102`（2026-11-05，用户：「点击之后，整段还是有明显的变化」）：
//    列表项的**续行**在源码里带着缩进空格，而阅读态由 HTML 在行首把空白折叠掉
//    ⇒ 编辑态若不藏，续行会整体右移（14 px 正文、两个空格实测 **7.00 px**）。
//    ⚠️ 代码块里的行首缩进是**内容**（列表项里贴一段 ``` 或四空格缩进的代码），⛔ 不许藏。
test('列表续行：行首缩进恒藏（`bugs/0102`）；代码块里的缩进是内容，⛔ 不藏', function () {
  const 顶层 = '- 条目一\n  续行文字\n- 条目二';
  assert.deepStrictEqual(hidden(顶层), ['- ', '  ', '- '],
    '续行的两个空格与 `- ` 一样是标记');
  assert.deepStrictEqual(marks(顶层).listLines.map(function (l) { return [l.line, l.kind, l.contentFrom]; }),
    [[0, 'bullet', 2], [1, 'plain', 8], [2, 'bullet', 15]],
    '续行也是一条列表行，`contentFrom` 落在第一个可见字符上');

  const 嵌套 = '- 一级\n  - 二级\n    二级续行\n';
  assert.deepStrictEqual(hidden(嵌套), ['- ', '  - ', '    '],
    '嵌套条目的标记从行首一路藏到正文起点，续行只藏缩进');
  assert.deepStrictEqual(marks(嵌套).listLines.map(function (l) { return [l.line, l.depth, l.contentFrom]; }),
    [[0, 0, 2], [1, 1, 9], [2, 1, 16]]);

  const 制表符 = '- 条目\n\t制表符续行';
  assert.deepStrictEqual(hidden(制表符), ['- ', '\t'], '`\\t` 与空格同口径');

  const 代码 = '- 条目\n\n  ```\n  代码一行\n    缩进四\n  ```\n';
  assert.deepStrictEqual(hidden(代码), ['- ', '```', '```'],
    '代码块里的行首缩进一个字节都不许动（围栏行本身另走塌高路）');
  assert.deepStrictEqual(marks(代码).listLines.filter(function (l) { return l.line === 3; })
    .map(function (l) { return l.contentFrom; }), [12], '代码行不吸落点（缩进就是它的正文起点）');

  assert.deepStrictEqual(hidden('普通段落\n  续行'), [],
    '⛔ 列表之外不动：那不是列表续行，藏掉就没有别的东西替它缩进了');
});

// ⭐⭐ `bugs/0112 B4`（2026-11-08）：列表的**第一条缩进**来自它自己的 `<ul>` / `<ol>`，
//    而编辑态宿主只搬**被替换那一块**的盒子。块本身就是列表时宿主搬的正是那个 `<ul>`
//    ⇒ 行级深度从 0 起；块是引用块、列表藏在里面时宿主搬的是引用块，内层 `<ul>` 的
//    `padding-left` 没人搬 ⇒ 行级深度必须从 1 起，否则正文比阅读态 `<li>` 左 28 px。
test('列表深度：引用块里的列表从 1 起（宿主没搬内层 `<ul>` 的缩进），顶层列表仍从 0 起（`bugs/0112 B4`）', function () {
  assert.deepStrictEqual(marks('> - 引用内\n').listLines.map(function (l) { return [l.line, l.depth]; }),
    [[0, 1]], '引用块里的列表：那一条 `--reader-list-indent` 也要补');
  assert.deepStrictEqual(marks('> 1. 一级\n>    - 二级\n').listLines.map(function (l) { return [l.line, l.depth]; }),
    [[0, 1], [1, 2]], '嵌套按层加一（引用块那条缩进只补一次）');
  assert.deepStrictEqual(marks('- 甲\n  - 乙\n').listLines.map(function (l) { return [l.line, l.depth]; }),
    [[0, 0], [1, 1]], '顶层列表从 0 起——宿主搬的就是这个 `<ul>`，⛔ 再加一就多缩进 28 px');
});

// ⭐⭐ `bugs/0305`（2026-11-10 用户报告：「项目符号再靠左的问题还是存在」）：
//    在段落 / 标题的编辑框里现敲出列表时，宿主是 `<p>` / `<h*>`——`box.js` 搬来的
//    `padding-left` 是 0，`<ul>` 那条缩进**没人给** ⇒ 列表行贴上正文左缘、圆点再往左
//    突出 16 px（离屏实测：行左 281 ＝ 宿主左缘、圆点 265；真 `<ul>` 宿主是 309 / 293）。
//    ⇒ `listHost: false` 时顶层列表的行级深度从 1 起。
//    ⚠️ 缺省（`undefined`，纯逻辑单测的旧口径）仍从 0 起——⛔ 别把"没传"当成"不是列表"。
test('列表深度：宿主不是 `<ul>`/`<ol>` 时顶层列表从 1 起（`bugs/0305`）', function () {
  const 源 = '- 甲\n  - 乙\n';
  function 深(o) {
    return D.markers(源, Object.assign({ tree: parse(源) }, o)).listLines.map(function (l) { return l.depth; });
  }
  assert.deepStrictEqual(深({ listHost: true }), [0, 1], '宿主是真列表：它自己的 padding-left 就是那一格');
  assert.deepStrictEqual(深({}), [0, 1], '未知宿主按旧口径（单测 / 旧探针）');
  assert.deepStrictEqual(深({ listHost: false }), [1, 2], '段落 / 标题宿主：整条列表右移一格缩进');
  // 引用块宿主原来那条补丁不受影响（它本来就 ＋1，⛔ 别叠成 ＋2）。
  const 引用 = '> - 甲\n';
  assert.deepStrictEqual(D.markers(引用, { listHost: false, tree: parse(引用) })
    .listLines.map(function (l) { return l.depth; }), [1], '引用块里仍只补一次');
  // ⭐ `design/0066`（2026-11-11）起列表内**没有段距这一路**：段落宿主里的松散列表
  //    与紧凑列表的条目判据逐值相同。⚠️ 这里原来断言的是 `listSepLines`（段距行），
  //    那套 emulation 已随模型 A 整段删除。
  //    ⚠️ 比较前要滤掉 `kind === 'plain'`：Lezer 会把松列表里的空行算作**续行**
  //    （它只影响 `cm-rmd-li` 的缩进，⛔ 不改高度、`marker` 为空 ⇒ 不画圆点）。
  const 松 = '- 甲\n\n- 乙\n';
  const 紧 = '- 甲\n- 乙\n';
  function 型(源) {
    return D.markers(源, { listHost: false, tree: parse(源) }).listLines
      .filter(function (l) { return l.kind !== 'plain'; })
      .map(function (l) { return [l.depth, l.kind]; });
  }
  assert.deepStrictEqual(型(松), 型(紧),
    '段落宿主：松散列表与紧凑列表的条目判据逐值相同（模型 A：空行不改变列表行判据）');
});

test('有序列表的编号按**位置**重算（源码 `1. 1. 1.` 渲染态是 1/2/3）', function () {
  assert.deepStrictEqual(marks('1. 甲\n1. 乙\n1. 丙\n').listLines.map(function (l) { return l.marker; }),
    ['1.', '2.', '3.']);
  assert.deepStrictEqual(marks('3. 甲\n9. 乙\n').listLines.map(function (l) { return l.marker; }),
    ['3.', '4.'], '起始号取第一条，之后按顺序（comrak 同口径）');
});

// ⭐⭐ `bugs/0111` A1/A2/A3 ＋ `bugs/0315` / `bugs/0317`（2026-11-12 用户核准）：
//    `markers()` 的 plan 里新增的**纯数据**。装饰层自己一条都不消费；`selection.js` 的落点
//    判定与 `input.js::lineBreakAction` 的续前缀 / 退标记按它来。⛔ 别当成装饰区间删掉。
test('plan 数据：列表行的 `markerFrom` 是**标记本身**的起点，⛔ 不是行首（`bugs/0111` A2）', function () {
  const p = marks('> - 甲');
  assert.strictEqual(p.listLines[0].markerFrom, 2, '`> - ` 的列表标记从 2 起（`> ` 是引用前缀）');
  assert.strictEqual(p.listLines[0].contentFrom, 4);
  assert.strictEqual(p.listLines[0].markerRaw, '-');
  assert.strictEqual(p.listLines[0].number, null, '无序项没有编号');
  // 普通 `- `：标记就在行首。
  assert.strictEqual(marks('- 甲').listLines[0].markerFrom, 0);
  // 续行没有标记 ⇒ `markerFrom` 落在行首，`kind` 仍是 `plain`、`number` 仍为 `null`。
  const 续 = marks('- 甲\n  续行\n').listLines[1];
  assert.deepStrictEqual([续.kind, 续.markerFrom, 续.contentFrom, 续.markerRaw, 续.number],
    ['plain', 4, 6, '', null]);
});

test('plan 数据：有序项的 `number` 与按位置渲染的 `marker` 一致，`markerRaw` 保留源码标点（`bugs/0111` A3）', function () {
  const p = marks('1. 甲\n1. 乙\n1) 丙\n');
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.number; }), [1, 2, 1],
    '每层列表各自从 1 起按位置算（`number` 只由装饰层给）');
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.marker; }), ['1.', '2.', '1.'],
    '渲染编号恒用 `.`（与阅读态 comrak 一致）');
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.markerRaw; }), ['1.', '1.', '1)'],
    '`markerRaw` 是源码原文：标点由 `input.js` 续行时沿用');
  assert.strictEqual(p.maxOrdered, 999999999, '`design/0063` F4c：10 位不是列表标记');
});

test('plan 数据：`rawRanges` 只去重**不合并**，`ranges` 仍按旧语义合并（`bugs/0317`）', function () {
  const p = marks('2. `x`');
  assert.deepStrictEqual(p.rawRanges, [{ from: 0, to: 3 }, { from: 3, to: 4 }, { from: 5, to: 6 }],
    '列表标记 `2. ` 与反引号各自成段，相邻**不**合并');
  assert.deepStrictEqual(p.ranges, [{ from: 0, to: 4 }, { from: 5, to: 6 }],
    '装饰层的合并语义一个字节都没动');
});

test('plan 数据：`prefixRanges` 只含**块前缀**，⛔ 不含行内标记（`bugs/0317`）', function () {
  assert.deepStrictEqual(marks('- **甲**').prefixRanges, [{ from: 0, to: 2 }],
    '强调标记不是块前缀（只有 `- `）');
  assert.deepStrictEqual(marks('> foo').prefixRanges, [{ from: 0, to: 2 }], '引用标记算块前缀');
  assert.deepStrictEqual(marks('## 标题').prefixRanges, [{ from: 0, to: 3 }], '标题标记算块前缀');
  assert.deepStrictEqual(marks('- [ ] 甲').prefixRanges, [{ from: 0, to: 6 }],
    '`- ` 与任务框 `[ ] ` 相邻 ⇒ 合并成一条');
  assert.deepStrictEqual(marks('用 `x` 表示').prefixRanges, [], '行内代码一个区间都不许进');
  assert.deepStrictEqual(marks('a\\\nb').prefixRanges, [], 'HardBreak 不是块前缀');
  assert.deepStrictEqual(marks('- 甲\n  续行').prefixRanges, [{ from: 0, to: 2 }, { from: 4, to: 6 }],
    '续行行首缩进算块前缀');
});

test('plan 数据：`prefixLevels` 是块前缀的**分层**视图（⛔ 不合并，`bugs/0111` K3）', function () {
  assert.deepStrictEqual(marks('- [ ] 甲').prefixLevels, [{ from: 0, to: 6 }],
    '列表标记 ＋ 同一行任务框 ＋ 缩进 ⇒ 一段');
  assert.deepStrictEqual(marks('> - 正文').prefixLevels, [{ from: 0, to: 2 }, { from: 2, to: 4 }],
    '引用一层 ＋ 列表一层');
  assert.deepStrictEqual(marks('> > 文').prefixLevels, [{ from: 0, to: 2 }, { from: 2, to: 4 }],
    '每一层 `>` 各一段');
  assert.deepStrictEqual(marks('## 标题').prefixLevels, [{ from: 0, to: 3 }], '标题标记一段');
  assert.deepStrictEqual(marks('- **甲**').prefixLevels, [{ from: 0, to: 2 }],
    '⛔ 行内标记不进分层');
  assert.deepStrictEqual(marks('- 甲\n  续行').prefixLevels, [{ from: 0, to: 2 }, { from: 4, to: 6 }],
    '续行行首缩进一段');
});

test('变异 m15：引用层相邻即合并 ⇒ `> > 文` 少一层（`bugs/0111` K3）', function () {
  const m15 = DECO_SRC.replace('            添层(lineOf(from), from, to);',
    '            添层(lineOf(from), from, to, true);');
  assert.notStrictEqual(m15, DECO_SRC, 'm15 没改到');
  assert.deepStrictEqual(loadModules(m15).markers('> > 文', { tree: parse('> > 文') }).prefixLevels,
    [{ from: 0, to: 4 }], 'm15 没红：两层引用被并成了一段');
});

// ⭐⭐ `bugs/0304` 候选 ④（2026-11-12）：行内代码的反引号必须留在字符流里（只压零宽），
//    否则 `Decoration.replace` 的 `cm-widgetBuffer` 零宽 `<img>`（U+FFFC）会参与 UAX#14 断行
//    ⇒「（」紧跟行内代码时编辑态折行点比阅读态差一个全角字。`zwRanges` 就是"哪些区间只压零宽"。
test('plan 数据：`zwRanges` 恰是**行内代码反引号**（多反引号逐条），与 `ranges` 并存（`bugs/0304`）', function () {
  assert.deepStrictEqual(marks('用 `code` 表示').zwRanges,
    [{ from: 2, to: 3 }, { from: 7, to: 8 }], '单反引号：两端的 ` 各一条');
  assert.deepStrictEqual(marks('`a` 与 `b`').zwRanges,
    [{ from: 0, to: 1 }, { from: 2, to: 3 }, { from: 6, to: 7 }, { from: 8, to: 9 }],
    '一段里的多组行内代码逐条列出（按 `from` 升序）');
  assert.deepStrictEqual(marks('``a`b``').zwRanges,
    [{ from: 0, to: 2 }, { from: 5, to: 7 }],
    '多反引号定界符整段算一条（`to-from == 2`）');
  assert.deepStrictEqual(marks('（`blocks.rs`').zwRanges,
    [{ from: 1, to: 2 }, { from: 11, to: 12 }], '`bugs/0304` 的触发形态（「（」紧跟行内代码）');
  // ⭐ 反面：围栏 / 缩进代码块里的 `CodeMark` 是**围栏符或内容**，⛔ 不进 `zwRanges`。
  const 围栏 = ['```rust', 'code', '```'].join('\n');
  assert.deepStrictEqual(marks(围栏).zwRanges, [], '围栏符不许留在字符流里（整行由 block widget 塌掉）');
  assert.deepStrictEqual(marks('    `x`').zwRanges, [], '缩进代码块里的反引号是内容，树里根本没有 CodeMark');
  // ⚠️ 这些区间**同时仍在 `ranges` 里**（落点 / 删除层读的是那份完整隐藏集合）。
  assert.deepStrictEqual(marks('用 `code` 表示').ranges,
    [{ from: 2, to: 3 }, { from: 7, to: 8 }], '⛔ 不许从隐藏集合里摘掉');
});

test('plan 数据：每个 `zwRanges` 区间都被某个 `ranges` 区间**完整包含**（拆分的唯一前提）', function () {
  const 样本 = [
    '用 `code` 表示',
    '`a` 与 `b`',
    '（`blocks.rs`',
    '[`a`](u)',
    '**粗 `x` 粗**',
    '> - `x` 引用列表',
    '``a`b``',
  ];
  样本.forEach(function (src) {
    const p = marks(src);
    p.zwRanges.forEach(function (z) {
      const 包 = p.ranges.filter(function (r) { return r.from <= z.from && z.to <= r.to; });
      assert.ok(包.length >= 1,
        JSON.stringify(src) + '：zw 区间 ' + JSON.stringify(z) + ' 没有被任何 ranges 区间完整包含');
    });
  });
});

test('plan 数据：`quoteLines` 的 `contentFrom` 覆盖 `> > ` 全层，空行 `blank` 为真（`bugs/0111` A1）', function () {
  assert.deepStrictEqual(marks('> foo').quoteLines,
    [{ line: 0, from: 0, markerFrom: 0, contentFrom: 2, blank: false }]);
  assert.deepStrictEqual(marks('> > foo').quoteLines,
    [{ line: 0, from: 0, markerFrom: 0, contentFrom: 4, blank: false }], '多层引用全含');
  assert.deepStrictEqual(marks('>').quoteLines,
    [{ line: 0, from: 0, markerFrom: 0, contentFrom: 1, blank: true }], '`>` 单独一行＝空引用行');
  assert.deepStrictEqual(marks('> \n').quoteLines,
    [{ line: 0, from: 0, markerFrom: 0, contentFrom: 2, blank: true }]);
  // ⚠️ 围栏里的 `>` 是**代码内容**（树里同样是 QuoteMark）⇒ 不导出。
  assert.deepStrictEqual(marks('```\n> > x\n```\n').quoteLines, []);
  // 多行：行号 / 行首偏移逐行给（`> ` 空行夹在中间也是 `blank`）。
  assert.deepStrictEqual(marks('> foo\n> > bar\n> \n').quoteLines.map(function (q) {
    return [q.line, q.from, q.contentFrom, q.blank];
  }), [[0, 0, 2, false], [1, 6, 10, false], [2, 14, 16, true]]);
});

// ⭐⭐ `bugs` 的变异自测：`number` 必须真的来自**按位置**的 `leave`（删掉它 ⇒ 上面的判据必红）。
test('变异 m23：`leave` 不写 `number` ⇒ 有序编号的 plan 数据断掉', function () {
  const 源 = '1. 甲\n1. 乙\n';
  const DECO = require('fs').readFileSync(require('path').join(__dirname, '../../src/live/decorations.js'), 'utf8');
  // ⚠️ 靶子随 `bugs/0116` §9 换代：`leave` 里现在写的是 `号`（分级字形要另算），
  //    但"写不写 `number`"这件事没变——`input.js` 靠它续行。
  const 锚 = '            层.items[i].rec.number = 号;';
  const mut = DECO.replace(锚, '            /* m23: number 不写 */');
  assert.notStrictEqual(mut, DECO, 'm23 没改到');
  const p = loadModules(mut).markers(源, { tree: parse(源) });
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.number; }), [null, null],
    'm23 没红：变异版仍在写 `number`');
  assert.deepStrictEqual(D.markers(源, { tree: parse(源) }).listLines
    .map(function (l) { return l.number; }), [1, 2], '负对照：产品版按位置给出 1 / 2');
});


test('任务列表：`[ ]` / `[x]` 一并藏掉，方框 widget 落在正文起点（`bugs/0092`）', function () {
  const src = '- [ ] 未完成\n- [x] 已完成\n';
  const p = marks(src);
  assert.deepStrictEqual(hidden(src), ['- [ ] ', '- [x] ']);
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.kind; }), ['task', 'task']);
  assert.deepStrictEqual(p.listLines.map(function (l) { return l.checked; }), [false, true]);
  assert.deepStrictEqual(p.tasks, [
    { pos: src.indexOf('未'), checked: false },
    { pos: src.indexOf('已'), checked: true },
  ], 'widget 的位置就是正文第一个字（`- [ ] ` 之后）');
});

test('接线：列表行贴 `cm-rmd-li`，任务框真的落成 `Decoration.widget`（`bugs/0092`）', function () {
  const f = fakeCM6();
  const field = D.createField(f.CM6, {})[0];
  const built = field.create(stateOf('- [ ] 甲'));
  assert.deepStrictEqual(f.calls.line, ['cm-rmd-li'], '列表行必须有行级装饰');
  assert.strictEqual(f.calls.widget.length, 1, '任务项必须有一个方框 widget');
  const w = built.decos.filter(function (d) { return !!d.widget; })[0];
  assert.strictEqual(w.from, 6, 'widget 落在 `- [ ] ` 之后的正文起点');
  assert.strictEqual(w.widget.checked, false);
});

// ⭐ `bugs/0093`：反斜杠硬换行在编辑态行尾可见（阅读态没有这个字符）。
test('硬换行：反斜杠与行尾两空格都藏掉，⛔ 不吞换行（`bugs/0093`）', function () {
  assert.deepStrictEqual(hidden('第一行\\\n第二行'), ['\\']);
  assert.deepStrictEqual(hidden('第一行  \n第二行'), ['  ']);
  assert.deepStrictEqual(hidden('第一行\n第二行'), [], '软换行没有标记可藏');
  // ⚠️ 反面：行中的反斜杠不是硬换行（`a\b` 是一个转义字符）。
  assert.deepStrictEqual(hidden('a\\b'), []);
});

// ⭐ `bugs/0089`：Setext 的下划线行在阅读态**不存在**，编辑态必须塌成 0 高。
test('Setext 下划线行进 `collapsedLines`（与围栏行同一条塌高路，`bugs/0089`）', function () {
  const p = marks('Setext 标题\n=====\n');
  assert.deepStrictEqual(p.ranges, [{ from: 10, to: 15 }], '`=====` 本身藏掉');
  assert.deepStrictEqual(p.collapsedLines.map(function (c) { return c.line; }), [1]);
  assert.strictEqual(p.collapsedLines[0].from, 10);
  assert.deepStrictEqual(marks('# ATX 标题').collapsedLines, [], 'ATX 标题只有一行，⛔ 不许塌');
  // `---` 在空行之后是分隔线，⛔ 不是 Setext（列表项之后同理）—— 树里也不会给 HeaderMark。
  assert.deepStrictEqual(marks('正文\n\n---\n').collapsedLines, []);
});

// ⭐⭐ 2026-11-08（`bugs/0090`）：引用块里的空行在阅读态是**段距**，不是一整行。
//    编辑态按源码行排时，它每条约比阅读态高 4.906 px（20.297 − 15.4），方向是**变高**。
test('引用空行：夹在内容之间进 `quoteGapLines`，连续多条只有第一条承载段距（`bugs/0090`）', function () {
  const 一条 = marks('> a\n>\n> b');
  assert.deepStrictEqual(一条.quoteGapLines.map(function (x) { return x.line; }), [1],
    '夹在内容之间的空引用行 ＝ 段距');
  assert.deepStrictEqual(一条.collapsedLines.map(function (x) { return x.line; }), [],
    '它⛔ 不许同时塌成 0 高（那样会比阅读态矮一个段距）');
  assert.deepStrictEqual(一条.quoteGapLines[0], { line: 1, from: 4, to: 5 },
    '`from` 是行首偏移（喂 `Decoration.line`）');

  const 两条 = marks('> a\n>\n>\n> b');
  assert.deepStrictEqual(两条.quoteGapLines.map(function (x) { return x.line; }), [1],
    '阅读态的段距只出现一次');
  assert.deepStrictEqual(两条.collapsedLines.map(function (x) { return x.line; }), [2],
    '连续的空引用行：第二条塌成 0 高');

  const 开头 = marks('>\n> a');
  assert.deepStrictEqual(开头.quoteGapLines, [], '开头的空引用行在阅读态不存在');
  assert.deepStrictEqual(开头.collapsedLines.map(function (x) { return x.line; }), [0]);

  const 结尾 = marks('> a\n>');
  assert.deepStrictEqual(结尾.quoteGapLines, [], '结尾的空引用行在阅读态不存在');
  assert.deepStrictEqual(结尾.collapsedLines.map(function (x) { return x.line; }), [1]);

  // ⚠️ 源码以 `\n` 结尾时 `split` 会多出一个**幻影行**：它不是内容，
  //    不能被当成"结尾空引用行后面还有内容"。
  const 结尾换行 = marks('> a\n>\n');
  assert.deepStrictEqual(结尾换行.quoteGapLines, [], '结尾换行不是"后面还有内容"');
  assert.deepStrictEqual(结尾换行.collapsedLines.map(function (x) { return x.line; }), [1]);

  const 普通 = marks('> a\n> b');
  assert.deepStrictEqual(普通.quoteGapLines, [], '普通引用行⛔ 不许被当成空行');
  assert.deepStrictEqual(普通.collapsedLines, []);
});

// ⭐⭐ `design/0085` C3（`bugs/0318`，2026-11-15 用户「批准这份设计」）：
//    **两侧都是列表行**的空引用行不是段距，它按普通行盒排（行高 ＝ 该处正文行高）。
test('引用空行·两侧是列表项：⛔ 不进 `quoteGapLines`、⛔ 不塌成 0 高（`bugs/0318`）', function () {
  const 一项 = marks('> - 甲\n>\n> - 乙');
  assert.deepStrictEqual(一项.quoteGapLines, [],
    '列表项之间的空行在阅读态是 `li[data-blanks]`（一行高），⛔ 不是段距 15.4px');
  assert.deepStrictEqual(一项.collapsedLines, [],
    '它也不许塌成 0 高 —— 阅读态那一格是**实打实的一行**');

  const 两条 = marks('> - 甲\n>\n>\n> - 乙');
  assert.deepStrictEqual(两条.quoteGapLines, [], '连续两条同族：都不按段距');
  assert.deepStrictEqual(两条.collapsedLines, [], '连续两条同族：也都不塌');

  // ⚠️ 回归（`bugs/0090`）：段落之间的空引用行仍是**段距**，⛔ 别把判据写成"所有空引用行"。
  const 段落之间 = marks('> 甲\n>\n> 乙');
  assert.deepStrictEqual(段落之间.quoteGapLines.map(function (x) { return x.line; }), [1],
    '两侧是普通段落 ⇒ 仍是段距（`bugs/0090` 那一半必须原样保留）');

  // ⚠️ 一侧列表、一侧段落 ⇒ 阅读态走段距（空行结束了那个列表）⇒ 仍是 `quoteGapLines`。
  const 一侧列表 = marks('> - 甲\n>\n> 乙');
  assert.deepStrictEqual(一侧列表.quoteGapLines.map(function (x) { return x.line; }), [1],
    '只有**两侧都是**列表行时才按一行高');

  // ⚠️ 列表项的**续行**（没有 `- ` 标记）也算列表行：它在阅读态就是同一个 `<li>`。
  const 续行 = marks('> - 甲\n>\n>   续');
  assert.deepStrictEqual(续行.quoteGapLines, [], '续行仍是列表项的一部分');
});

// ⭐⭐ `design/0085` C4：**第二层起的引用盒**。宿主只搬被换掉的那个顶层元素的盒子
//    ⇒ `qdepth` 只数"宿主没搬的那几层"，且按**树里的范围**算（lazy 续行同样在范围内）。
test('嵌套引用 `quoteDepths`：只补宿主没搬的那几层（`design/0085` C4）', function () {
  // 顶层就是引用块 ⇒ 最外层那一份由 host 搬过。
  assert.deepStrictEqual(marks('> 文').quoteDepths, [], '一层引用：宿主搬过了，行级不补');
  const 两层 = marks('> > 文');
  assert.deepStrictEqual(两层.quoteDepths, [{ line: 0, from: 0, qdepth: 1 }],
    '两层引用：第二层要按行补一个盒子');
  assert.deepStrictEqual(marks('> > > 文').quoteDepths, [{ line: 0, from: 0, qdepth: 2 }]);
  assert.deepStrictEqual(marks('> > > > 文').quoteDepths, [{ line: 0, from: 0, qdepth: 3 }],
    '上限 3 层（`live.css` 只有三条规则）');
  assert.deepStrictEqual(marks('> > > > > 文').quoteDepths, [{ line: 0, from: 0, qdepth: 3 }],
    '更深也夹到 3');

  // 顶层是列表 ⇒ 宿主搬的是 `<ul>` 的 `padding-left`，引用那一层**没人搬**。
  assert.deepStrictEqual(marks('- > 文').quoteDepths, [{ line: 0, from: 0, qdepth: 1 }],
    '列表里的引用：竖线与让位都得按行补');
  assert.deepStrictEqual(marks('- > > 文').quoteDepths, [{ line: 0, from: 0, qdepth: 2 }]);

  // 多行块：只在需要补的行上产出；lazy 续行（`> a\nb`）在树里仍在引用范围里。
  const 多行 = marks('> 甲\n> > 乙');
  assert.deepStrictEqual(多行.quoteDepths, [{ line: 1, from: 4, qdepth: 1 }],
    '第一行只在一层引用里（宿主搬了）⇒ 不补');
  const lazy = marks('> 甲\n乙');
  assert.deepStrictEqual(lazy.quoteDepths, [], 'lazy 续行也只在一层引用里');

  // 围栏行由 block widget 顶替 / 塌成 0 高 ⇒ 不补（补了也看不见，只是白写一串属性）。
  const 围栏 = marks('> > ```\n> > a\n> > ```');
  assert.deepStrictEqual(围栏.quoteDepths.map(function (q) { return q.line; }), [1],
    '引用里的代码**内容行**要补，围栏行不补');
});

// ⭐⭐ 2026-11-08（`bugs/0091`）：引用块里的围栏代码块在编辑态丢 mono / 字号 / 内边距。
//    围栏行已经走 `cm-rmd-fence` 塌成 0 高 ⇒ ⛔ 不许进 `nestedCodeLines`；
//    上下内边距是 `pre code` **整块一份** ⇒ 用 `first` / `last` 标出首 / 末内容行。
test('引用里的围栏代码块：内容行进 `nestedCodeLines`，围栏行不进，first/last 正确（`bugs/0091`）', function () {
  const src = '> ```\n> a\n> b\n> ```';
  const p = marks(src);
  assert.deepStrictEqual(p.nestedCodeLines.map(function (c) { return c.line; }), [1, 2]);
  assert.deepStrictEqual(p.nestedCodeLines.map(function (c) { return c.from; }), [6, 10],
    '`from` 是行首偏移（喂 `Decoration.line`）');
  assert.deepStrictEqual(p.nestedCodeLines.map(function (c) { return [c.first, c.last]; }),
    [[true, false], [false, true]], '首 / 末内容行各只有一条');
  assert.deepStrictEqual(p.fenceLines.map(function (f) { return f.line; }), [0, 3],
    '围栏行仍走塌高路，⛔ 不混进代码行');

  assert.deepStrictEqual(marks('```\nx\n```').nestedCodeLines, [],
    '顶层代码块由 host 类（`.cm-rmd-code`）给，⛔ 不许登记（否则样式叠两遍）');
});

// ⭐⭐ 2026-11-08（`bugs/0091`）：引用块里的标题在编辑态丢上下外边距（首行文字上跳 11.859 px）。
test('引用里的标题：上下留白点，紧邻空引用行的一侧不补（`bugs/0091`）', function () {
  const 两端 = marks('> p\n> ## h\n> q');
  assert.deepStrictEqual(两端.nestedHeadingSpaces.map(function (s) { return [s.line, s.where]; }),
    [[1, 'before'], [1, 'after']], '上下都是正文 ⇒ 两侧都要补');
  assert.deepStrictEqual(两端.nestedHeadingSpaces.map(function (s) { return s.from; }), [4, 4],
    '`from` 是行首偏移');

  assert.deepStrictEqual(marks('> ## h').nestedHeadingSpaces.map(function (s) { return [s.line, s.where]; }),
    [[0, 'before']],
    '引用块的第一行标题也要补上留白：`padding` 挡住外边距折叠，阅读态它确实占着高度');

  const 后空行 = marks('> ## h\n>\n> p');
  assert.deepStrictEqual(后空行.nestedHeadingSpaces.map(function (s) { return [s.line, s.where]; }),
    [[0, 'before']], '下方紧邻空引用行 ⇒ 下留白不补（段距已承载）；上方仍要补');

  const 前空行 = marks('> p\n>\n> ## h\n> q');
  assert.deepStrictEqual(前空行.nestedHeadingSpaces.map(function (s) { return [s.line, s.where]; }),
    [[2, 'after']], '上方紧邻空引用行 ⇒ 上留白不补；下方还有内容 ⇒ 下留白照补');

  const 相邻 = marks('> ## a\n> ### b');
  assert.deepStrictEqual(相邻.nestedHeadingSpaces.map(function (s) { return [s.line, s.where]; }),
    [[0, 'before'], [0, 'after']],
    '相邻标题只补前一个的下留白（外边距折叠），后一个的上方跳过');

  assert.deepStrictEqual(marks('> p\n> ## h').nestedHeadingSpaces.map(function (s) { return [s.line, s.where]; }),
    [[1, 'before']], '块的最后一行不补下留白（`.doc blockquote > :last-child`）');

  assert.deepStrictEqual(marks('- ## h').nestedHeadingSpaces, [],
    '顶层列表项里的标题：外边距穿过 li/ul 折到列表外，不在被替换元素的 border box 里');
});

// ⭐⭐ 接线：`markers()` 算得再对，`createField` 不贴类就等于没修。
//    这是 `bugs/0015` / `bugs/0092` 同一条纪律（纯逻辑判据看不见"产品到底接没接"）。
test('接线：内层代码行 / 首末行 / 标题留白点必须真的贴成行级类（`bugs/0091`）', function () {
  function lineDecos(src) {
    // ⚠️ 用带 `WidgetType` 的桩：产品路径上围栏行是 block widget（`bugs/0298` 1b），
    //    不再是行级类；这一条只看**内容行**的类。
    const f = fakeCM6({ widgetType: true });
    const field = D.createField(f.CM6, {})[0];
    const built = field.create(stateOf(src));
    return built.decos.filter(function (d) { return !!d.cls; })
      .map(function (d) { return [d.from, d.cls]; });
  }
  assert.deepStrictEqual(lineDecos('> ```\n> a\n> b\n> ```'), [
    [6, 'cm-rmd-code-line'], [6, 'cm-rmd-code-first'],
    [10, 'cm-rmd-code-line'], [10, 'cm-rmd-code-last'],
  ], '内容行 / 首末行各就各位；围栏行走 block widget，⛔ 不再叠行级类');

  assert.deepStrictEqual(lineDecos('> p\n> ## h\n> q'), [
    [4, 'cm-rmd-h2'],
    [4, 'cm-rmd-heading-space-before'],
    [4, 'cm-rmd-heading-space-after'],
  ], '标题的上下留白点必须真的贴成行级类');
});


// ── ⭐ `bugs/0106`：编辑态任务方框必须自带 comrak 在阅读态写的那个**字面空格** ────────
//
// 取证来自离屏探针（`/tmp/task-repro/run-toggle.sh`，真载荷 ＋ 假后端，`.prohibited` ＋ alpha=0）：
//   修之前：阅读态正文左缘 **331**、编辑态 **327**（方框盒两边都是 `l=311` / `12×12`），
//          还伴随「这一块变矮了 −23.8 px」——长行在两态的换行点不同；
//   修之后：两态都是 **331**，告警消失（同一个探针同一天实跑）。
// ⚠️ 打勾会**退出编辑态**（`doToggleTask` 第 ① 步），所以这 4 px 就是用户看到的
//    「打勾前和打勾后格式还是有变动」。

/** 只够跑 `taskBoxDom()` 的假 DOM（记录结构，不做布局）。 */
function fakeDom() {
  function el(tag) {
    return {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      className: '',
      children: [],
      attrs: {},
      appendChild: function (n) { this.children.push(n); return n; },
      setAttribute: function (k, v) { this.attrs[k] = String(v); },
    };
  }
  return { createElement: el, createTextNode: function (v) { return { nodeType: 3, nodeValue: v }; } };
}

/** 在假 `document` 底下取一块 `- [x] 甲` 的任务框 DOM。 */
function taskBoxDomOf(mod, cm6) {
  const field = mod.createField(cm6, {})[0];
  const built = field.create(stateOf('- [x] 甲'));
  const w = built.decos.filter(function (d) { return !!d.widget; })[0];
  // ⚠️ `@ts-check` 下 `document` 是 DOM 的 `Document`，这里的假 DOM 只有三个方法
  //    ⇒ 从 `global` 这个 `any` 口子进（⛔ 不是给 `Document` 写一份 260 个成员的空壳）。
  const g = /** @type {any} */ (global);
  const prev = g.document;
  g.document = fakeDom();
  try {
    return w.widget.toDOM();
  } finally {
    if (prev === undefined) delete g.document;
    else g.document = prev;
  }
}

test('任务框 widget 的 DOM ＝ 方框 ＋ **一个字面空格**（`bugs/0106`）', function () {
  const f = fakeCM6();
  const dom = taskBoxDomOf(D, f.CM6);
  assert.strictEqual(dom.className, 'cm-rmd-taskbox-wrap', '外层必须是那一层 span（⊕ 只装方框与空格）');
  const box = dom.children[0];
  assert.strictEqual(box.tagName, 'INPUT');
  assert.strictEqual(box.type, 'checkbox');
  assert.strictEqual(box.className, 'cm-rmd-taskbox');
  assert.strictEqual(box.checked, true, '勾选状态来自源码那一行');
  assert.strictEqual(dom.children.length, 2);
  assert.deepStrictEqual({ t: dom.children[1].nodeType, v: dom.children[1].nodeValue },
    { t: 3, v: ' ' },
    '方框后面必须**排在 input 之后**跟一个字面空格——阅读态 comrak 写的是 `disabled="" /> `');
});

const fs = require('node:fs');
const path = require('node:path');
const DECO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live', 'decorations.js'), 'utf8');

/**
 * 在独立模块作用域里跑一遍源码（不碰全局 `window`）。
 * ⚠️ `design/0065` P1 起 `decorations.js` 加载期要取 `live/geometry.js`（`require('./geometry.js')`）：
 *    `new Function` 的函数体在**全局**作用域里求值，那儿没有 `require` ⇒ 必须显式注进去，
 *    且 `./geometry.js` 要映射到产品那份（⛔ 不是相对 `tests/js/` 去解析）。
 */
function loadModules(src) {
  const mod = { exports: {} };
  const req = function (p) {
    return p === './geometry.js' ? require('../../src/live/geometry.js') : require(p);
  };
  new Function('module', 'window', 'require', src)(mod, undefined, req);
  return mod.exports;
}

test('变异 m13：不补那个空格 ⇒ 上面那条判据必红', function () {
  const m13 = DECO_SRC.replace('      wrap.appendChild(document.createTextNode(\' \'));\n', '');
  assert.notStrictEqual(m13, DECO_SRC, 'm13 没改到');
  const mut = loadModules(m13);
  const f = fakeCM6();
  const dom = taskBoxDomOf(mut, f.CM6);
  assert.strictEqual(dom.children.length, 1, 'm13 没红：空格还在，编辑态仍会比阅读态左 4 px');
  const good = taskBoxDomOf(D, fakeCM6().CM6);
  assert.strictEqual(good.children.length, 2, '负对照：产品版有那个空格');
});

// ⭐ `bugs/0112 B4` 的变异自测（与探针 M47 同一处靶子）：把引用块那条缩进打回去，
//    上面「引用块里的列表从 1 起」必须红；顶层列表那条断言不受影响（负对照）。
// ⚠️ `design/0065` P1 起"补位规则"搬进了 `src/live/geometry.js` ⇒ 靶子改成**传入参数**那一行
//    （⛔ 不再有 `const 深 = listStack.length + 深基` 可打）。判据与期望值一个都没动。
test('变异 m14：`topIsList` 恒真 ⇒ 引用块那条缩进没了，上面那条判据必红', function () {
  const m14 = DECO_SRC.replace('              topIsList: 作顶层块,',
    '              topIsList: true,');
  assert.notStrictEqual(m14, DECO_SRC, 'm14 没改到');
  const mut = loadModules(m14);
  const 源 = '> - 引用内\n';
  assert.deepStrictEqual(mut.markers(源, { tree: parse(源) }).listLines.map(function (l) { return l.depth; }),
    [0], 'm14 没红：引用块里的列表仍从 1 起');
  assert.deepStrictEqual(D.markers(源, { tree: parse(源) }).listLines.map(function (l) { return l.depth; }),
    [1], '负对照：产品版从 1 起');
  const 顶层源 = '- 甲\n';
  assert.deepStrictEqual(mut.markers(顶层源, { tree: parse(顶层源) }).listLines.map(function (l) { return l.depth; }),
    [0], '负对照：顶层列表仍是 0（这条变异只影响「宿主不是列表」那一支）');
});

// ⭐⭐ 2026-11-09（`bugs/0021`）→ **2026-11-11 已被 `design/0066` 取代**：列表段距的纯逻辑判据。
//
// 旧口径（模型 B）把松散列表的段距折成两路装饰：`listGapLines`（前一行补 `padding-bottom`）
// 与 `listSepLines`（空行行高 ＝ 段距），并在空条目后面把空行贴成 `cm-rmd-collapsed`。
// 用户 2026-11-11 裁定「**永远是紧凑的状态，松散不存在，如果是空行，就把空行展示出来**」
// ⇒ 模型 A：列表内**没有段距这一路装饰**；空行就是普通的一行（行高由行盒天然给出）。
// ⇒ 这一组判据从"算出哪些行要补段距"翻转成"**一个都不产**"，与 `design/0066` §4 第一行一致：
//    同一份源码在"无空行 / 1 空行 / 3 空行"下产出的行装饰只差行号，⛔ 不差品种。
// ⚠️ 空行的**高度**不归这一层管（`markers()` 只出类名）：编辑态是自然行高，
//    阅读态由 `render.rs::写空行属性` 的 `data-blanks` ＋ `typography.css` 的 `[data-blanks]`
//    给出，两态等高的判据在离屏探针（`W8L-*` / `B*-3a`），⛔ 别在这里复制一份几何。
test('模型 A：列表内空行不产任何行装饰，松散与紧凑的列表判据逐值相同（`design/0066`）', function () {
  /** **改高度**的行装饰落点：`[行号, 类名]`（⛔ 不含 `bodies` / `cm-rmd-li`，见下）。 */
  function 高度装饰(源) {
    const p = marks(源);
    const out = [];
    (p.headings || []).forEach(function (h) { out.push([h.line, 'cm-rmd-h' + h.level]); });
    (p.fenceLines || []).forEach(function (f) { out.push([f.line, 'cm-rmd-fence']); });
    (p.collapsedLines || []).forEach(function (f) { out.push([f.line, 'cm-rmd-collapsed']); });
    (p.quoteGapLines || []).forEach(function (g) { out.push([g.line, 'cm-rmd-quote-gap']); });
    (p.nestedHeadingSpaces || []).forEach(function (s) {
      out.push([s.line, 'cm-rmd-heading-space-' + s.where]);
    });
    out.sort(function (a, b) { return a[0] - b[0] || (a[1] < b[1] ? -1 : 1); });
    return out;
  }
  /** 源码里**完全空**的行号（含文件末尾的幻影行，它本来也不该有装饰）。 */
  function 空行号(源) {
    const out = [];
    源.split('\n').forEach(function (行, n) { if (行.trim() === '') out.push(n); });
    return out;
  }
  /** 列表行的「品种指纹」：深度 ＋ 品种，⛔ 不含行号（空行只让行号平移）。 */
  function 列表型(源, 滤续行) {
    return marks(源).listLines
      .filter(function (l) { return !滤续行 || l.kind !== 'plain'; })
      .map(function (l) { return [l.depth, l.kind]; });
  }

  // ① 判据翻转的本体：段距那两路连**键**都不再存在（⛔ 别把 emulation 加回来）。
  const 平 = marks('- a\n\n- b\n');
  assert.ok(!('listGapLines' in 平) && !('listSepLines' in 平),
    '`design/0066` 起 `markers()` 不再产 `listGapLines` / `listSepLines`');

  // ② 列表内的空行**一个改高度的行装饰都不许有**（旧口径会给它 `cm-rmd-collapsed`
  //    或 `cm-rmd-li-sep`，两者都改行高）。
  //    ⚠️ `cm-rmd-li` 允许落在空行上：Lezer 把松列表里的空行算作**续行**（`kind: 'plain'`），
  //    而 `cm-rmd-li` 只给 `position: relative` ＋ 缩进带，`marker` 为空 ⇒ 不画圆点、
  //    ⛔ 不改高度。下面 ③ 会把这两点钉住。
  const 用例 = [
    '- a\n- b\n',
    '- a\n  - b\n- c\n',
    '- a\n  - b\n',
    '- a\n\n- b\n',
    '- a\n\n- b\n- c\n',
    '- a\n- b\n  - c\n\n  - d\n',
    '- [ ] \n- [ ] \n\n\n\n- [ ] 验收\n',
    '- 甲\n\n  ```\n  x\n  ```\n\n- 乙\n',
  ];
  用例.forEach(function (源) {
    const 装饰 = 高度装饰(源).map(function (x) { return x[0]; });
    空行号(源).forEach(function (n) {
      assert.ok(装饰.indexOf(n) < 0,
        '第 ' + n + ' 行是空行，却拿了改高度的行装饰：' + JSON.stringify(源) + ' → ' + JSON.stringify(装饰));
    });
    空行号(源).forEach(function (n) {
      const 行 = marks(源).listLines.filter(function (l) { return l.line === n; });
      行.forEach(function (l) {
        assert.strictEqual(l.kind, 'plain', '空行若进了 `listLines`，只能是续行（不画标记）');
        assert.strictEqual(l.marker, '', '空行上的列表行不许有圆点/编号');
      });
    });
  });

  // ③ 松散与紧凑：**条目**的品种/深度逐值相同，只在行号上差空行那几行。
  assert.deepStrictEqual(列表型('- a\n\n- b\n', true), 列表型('- a\n- b\n', true), '1 条空行');
  assert.deepStrictEqual(列表型('- a\n\n\n\n- b\n', true), 列表型('- a\n- b\n', true), '3 条空行');
  assert.deepStrictEqual(列表型('- [ ] 甲\n\n- [ ] 乙\n', true), 列表型('- [ ] 甲\n- [ ] 乙\n', true),
    '任务项同口径');
  assert.deepStrictEqual(列表型('- a\n- b\n  - c\n\n  - d\n', true), 列表型('- a\n- b\n  - c\n  - d\n', true),
    '空行在**嵌套列表内部**：外层与内层的条目判据都不变');
});

// ⭐ 变异自测（`tests.md`：没做过变异测试的断言不算数）：`design/0066` §4 的三条变异里，
//    编辑侧的两条（②空行仍塌 0 高、③恢复段距装饰）在这里；③的阅读侧那一半在
//    `live-style.test.js`（CSS），①的渲染侧在 `render.rs::列表内空行写成_data_blanks`。
//    m21 把列表里的空行重新塞回塌高路 ⇒ ②必红；m22 让 plan 重新带 `listGapLines` ⇒ ①必红。
//    ⚠️ 旧编号 m15 / m16 / m18 / m19 / m20 全部退役（它们要替换的源码已随模型 A 删除）。
test('变异 m21 / m22：模型 A 的两条静默回归路径各自打红（`design/0066` §4）', function () {
  const 源 = '- 甲\n\n- 乙\n';
  const 锚 = '    listLines.sort(function (a, b) { return a.line - b.line; });';

  const m21 = DECO_SRC.replace(锚, 锚 + '\n' + [
    '    (function () {',
    '      for (let n = 1; n <= 末行号; n++) {',
    "        if (src.slice(lineStarts[n], 行末(n)).trim() !== '') continue;",
    '        if (lineDepth[n - 1] === undefined) continue;',
    '        collapsedLines.push({ line: n, from: lineStarts[n], to: 行末(n) });',
    '      }',
    '    })();',
  ].join('\n'));
  assert.notStrictEqual(m21, DECO_SRC, 'm21 没改到');
  assert.deepStrictEqual(loadModules(m21).markers(源, { tree: parse(源) })
    .collapsedLines.map(function (c) { return c.line; }), [1],
  'm21 没红：列表里的空行又被塌成 0 高（两态高差回来了）');
  assert.deepStrictEqual(D.markers(源, { tree: parse(源) }).collapsedLines, [],
    '负对照：产品版列表里的空行不塌');

  const 返回锚 = '      fenceLines: fenceLines, collapsedLines: collapsedLines, listLines: listLines, tasks: tasks,';
  const m22 = DECO_SRC.replace(返回锚, 返回锚 + '\n'
    + '      listGapLines: listLines.map(function (l) { return { line: l.line, from: l.from }; }),');
  assert.notStrictEqual(m22, DECO_SRC, 'm22 没改到');
  assert.ok('listGapLines' in loadModules(m22).markers(源, { tree: parse(源) }),
    'm22 没红：段距装饰又回来了');
  assert.ok(!('listGapLines' in D.markers(源, { tree: parse(源) })),
    '负对照：产品版不再产段距装饰');
});

// ⭐ `bugs/0305` 的变异自测：m17 把宿主品种恒报成 `'list'` ⇒ 段落宿主里的列表又贴上正文左缘。
//    ⚠️ 旧编号 m18（"宿主不是列表 ⇒ 不算顶层"）随模型 A **退役**：`帧.顶层` 只服务于段距规划，
//       而段距那一路已经整段删除，再守它等于给一个不存在的量做变异。
// ⚠️ `design/0065` P1 起"补位规则"本身在 `src/live/geometry.js` ⇒ m17 的靶子只能是
//    **接线那一行**（`decorations.js` 报给函数的 `hostKind`）；规则本体的变异在
//    `tests/js/live-geometry.test.js` 的 g2 / g3（那里直接改纯函数）。判据与期望值一个都没动。
test('变异 m17：宿主判据承重（`bugs/0305`）', function () {
  const m17 = DECO_SRC.replace(
    "              hostKind: o.listHost === true ? 'list' : (o.listHost === false ? 'box' : undefined),",
    "              hostKind: 'list',");
  assert.notStrictEqual(m17, DECO_SRC, 'm17 没改到');
  const 源 = '- 甲\n';
  assert.deepStrictEqual(loadModules(m17).markers(源, { listHost: false, tree: parse(源) })
    .listLines.map(function (l) { return l.depth; }), [0], 'm17 没红：段落宿主里的列表仍从 0 起');
  assert.deepStrictEqual(D.markers(源, { listHost: false, tree: parse(源) })
    .listLines.map(function (l) { return l.depth; }), [1], '负对照：产品版从 1 起');
});

// ⭐⭐ 2026-11-10（`bugs/0307` ①）→ **2026-11-11 已被 `design/0066` 取代**：任务列表。
//    旧口径要在这里证明"任务项与普通项一样补段距"（任务项的正文不在 `Paragraph` 里，
//    由 GFM 的 `Task → TaskMarker ＋ 行内片段` 包着，旧算法一度对它们一个段距都不补）。
//    模型 A 之后段距不存在，判据翻成"任务项与普通项的**行级判据**逐值相同，空条目不再塌行"。
test('模型 A：任务项与普通项的行级判据一致，空条目不再塌行（`bugs/0307` ①② 已作废）', function () {
  function 深(源) {
    return marks(源).listLines.map(function (l) { return l.depth; });
  }
  assert.deepStrictEqual(深('- [ ] 甲\n- [ ] 乙\n\n- [ ] 丙\n'), 深('- 甲\n- 乙\n\n- 丙\n'),
    '松散任务列表与同形普通列表的深度逐值相同');
  assert.deepStrictEqual(深('- [ ] 甲\n- [ ] 乙\n'), 深('- 甲\n- 乙\n'), '紧凑同样');
  // 空条目（`- [ ] `）就是普通一行：后面三条空行**一条都不塌**（旧口径要塌成 0 高）。
  const 空条目 = '- [ ] \n- [ ] \n\n\n\n- [ ] 验收\n';
  assert.deepStrictEqual(marks(空条目).collapsedLines, [],
    '空条目后面的空行必须是普通行高（模型 A：空行照排）');
  assert.deepStrictEqual(marks(空条目).listLines.filter(function (l) { return l.kind !== 'plain'; })
    .map(function (l) { return [l.line, l.kind]; }),
  [[0, 'task'], [1, 'task'], [5, 'task']], '空条目本身仍是一条列表行');
  assert.deepStrictEqual(marks('- [ ] 甲\n  续行\n- [ ] 乙\n').listLines
    .map(function (l) { return [l.line, l.kind]; }),
  [[0, 'task'], [1, 'plain'], [2, 'task']], '续行照旧（`bugs/0102`）');
});

// ── 回车落点的端到端（`bugs/0308`）：真解析器 → 隐藏集合 → 落点 → 换行动作 ──────
//
// ⚠️ 单测各测一段（`live-selection.test.js` 测落点、`live-input.test.js` 测换行），
//    这一条用**产品同一个解析器**把三段串起来——用户看到的正是这串算出来的最终文本。
//    ⭐ 手工构造的隐藏集合可以和真 `markers()` 不一致（例如 `**` 独占一行时
//    CommonMark 根本不成强调）；串起来才验得到"真树给出的区间"这一层。
const LSel = require('../../src/live/selection.js');
const LIn = require('../../src/live/input.js');

/** `Text` 的最小替身（`lineAt(pos)` 的 `to` 是行尾**之前**，与 CM6 同口径）。 */
function 行适配(text) {
  const lines = String(text).split('\n');
  const starts = [];
  let p = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(p);
    p += lines[i].length + 1;
  }
  return {
    length: String(text).length,
    lines: lines.length,
    lineAt: function (pos) {
      const at = Math.max(0, Math.min(pos, String(text).length));
      let i = lines.length - 1;
      for (let k = 0; k < lines.length; k++) {
        if (at <= starts[k] + lines[k].length) { i = k; break; }
      }
      return { number: i + 1, from: starts[i], to: starts[i] + lines[i].length, text: lines[i] };
    },
  };
}

/** 走一遍 `main.js` 裸 `Enter` 分支的纯逻辑那半：落点 → `lineBreakAction` → 最终文本。 */
function 回车后(text, pos) {
  const plan = marks(text);
  const doc = 行适配(text);
  const q = LSel.lineEndInsertPoint(plan.ranges, doc, pos);
  const at = q >= 0 ? q : pos;
  const act = LIn.lineBreakAction(text, plan, at, at);
  return act.type === 'delete'
    ? text.slice(0, act.from) + text.slice(act.to)
    : text.slice(0, act.from) + (act.data || '') + text.slice(act.to);
}

test('⭐ `bugs/0308`：行尾回车不劈开闭合标记（真解析器的隐藏集合）', function () {
  assert.strictEqual(回车后('**asdfdf**', 8), '**asdfdf**\n', '闭合 `**` 之前 ⇒ 挪到它之后');
  assert.strictEqual(回车后('`code`', 5), '`code`\n', '行内代码同理');
  assert.strictEqual(回车后('甲\n**乙**', 5), '甲\n**乙**\n', '第二行同理');
  assert.strictEqual(回车后('- **完成**', 6), '- **完成**\n- ', '列表项：换行落在闭合标记之后，续写照常');
  // 负对照：句子中间（链后还有可见内容）⛔ 不许搬——光标本来就在可见处。
  assert.strictEqual(回车后('前**重**后', 4), '前**重\n**后', '句子中间仍在可见处断行');
  // 负对照：空引用行（行内只有标记）⛔ 不许搬——搬了会把换行插到 `> ` **前面**（`bugs/0115` 的对称形态）。
  assert.strictEqual(回车后('甲\n> ', 2), '甲\n\n> ', '`> ` 独占一行时标记不翻到新行上面');
});
