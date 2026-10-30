// `design/0047` §2.9 装饰层的**纯逻辑判据**：该隐藏哪些标记、哪些行必须原样显示。
//
// ⚠️ 这一份测的是 `src/live/decorations.js::markers()`（纯函数，不碰 CM6 也不碰 DOM）。
//    真正的 `Decoration` 行为（零宽替换、`RangeError`）要真 `EditorView` ⇒ 那半在 §7.2 的接线闸门。
//
// ⭐ 三类错在屏幕上都不报错：
//   ① 藏进围栏内部（代码块的内容被吃掉）；
//   ② 藏了光标所在行（用户看不到 `#`，"空格删不掉"变成玄学）；
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

test('⭐ 光标所在行：一个标记都不藏（用户要看得见自己正在改的源码）', function () {
  assert.deepStrictEqual(hidden('# 标题', { activeLines: [0] }), []);
  assert.deepStrictEqual(hidden('a\n# 标题\nb', { activeLines: [1] }), []);
  // ⚠️ 反例：只标了别的行 ⇒ 这一行照常藏
  assert.deepStrictEqual(hidden('a\n# 标题\nb', { activeLines: [0] }), ['# ']);
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

// ⭐⭐ `design/0052` U5：围栏行在**非活动**时整行塌成 0 高（`cm-rmd-fence`）。
//    ⚠️ 只藏标记不够——空行仍占一整行高，用户看到的是「代码块上下各多一条空行」，
//    而渲染态里那两行**根本不存在**（旧的 `layoutSlack().fences` 就是在给这两行记账）。
test('⭐ 非活动围栏行进 `fenceLines`；**活动行不进**（那一行要能看见、能改语言标记）', function () {
  const src = ['```rust', 'code', '```'].join('\n');
  assert.deepStrictEqual(marks(src).fenceLines, [{ line: 0, from: 0 }, { line: 2, from: 13 }]);
  assert.deepStrictEqual(marks(src, { activeLines: [0] }).fenceLines, [{ line: 2, from: 13 }],
    '光标在第一行 ⇒ 只有收尾那条塌掉');
  assert.deepStrictEqual(marks(src, { activeLines: [0, 2] }).fenceLines, [], '两条都活动 ⇒ 一条都不塌');
  // ⚠️ 活动行的标记也照常显示（规则 2），两件事互相独立
  assert.deepStrictEqual(hidden(src, { activeLines: [0] }), ['```']);
});

// ⭐⭐ `design/0052` U5 的接线：`fenceLines` 必须真的变成 `cm-rmd-fence` 行级类。
//    ⚠️ 纯逻辑说"这一行该塌"而没接线 ⇒ 屏幕上围栏行**仍占一整行高**，
//    表现是「代码块上下各多一条空行」——而 `markers()` 的判据、`B-3b` 的几何**都看不见**
//    （前者只看区间，后者的 `fences` 那时还是 2）。这就是"纯逻辑对、没接线等于没修"。
test('⭐⭐ 接线：`fenceLines` 必须真的贴成 `cm-rmd-fence`（漏了围栏行就白占两行高）', function () {
  const f = fakeCM6();
  const field = D.createField(f.CM6, { activeLineIndexes: function () { return []; } })[0];
  const built = field.create(stateOf(['```rust', 'code', '```'].join('\n')));
  // ⚠️ `Decoration.line` 的 spec 按类名缓存 ⇒ 造对象只发生**一次**（判据看 `decos` 里的落点）
  assert.deepStrictEqual(f.calls.line, ['cm-rmd-fence'], '两条围栏行共用同一个 spec');
  const got = built.decos.filter(function (d) { return d.cls === 'cm-rmd-fence'; });
  assert.deepStrictEqual(got.map(function (d) { return d.from; }), [0, 13], '落的是**行首偏移**，两条都要有');
  // ⚠️ 反面：光标停在第 0 行 ⇒ 那一行不塌（否则用户改不了语言标记），只剩收尾那条
  const f2 = fakeCM6();
  const field2 = D.createField(f2.CM6, { activeLineIndexes: function () { return [0]; } })[0];
  const built2 = field2.create(stateOf(['```rust', 'code', '```'].join('\n')));
  assert.deepStrictEqual(built2.decos.filter(function (d) { return d.cls === 'cm-rmd-fence'; })
    .map(function (d) { return d.from; }), [13], '活动的开围栏**必须留着**（它要显示 ```rust 让人改）');
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
function fakeCM6() {
  const calls = { from: 0, fromArg: null, line: [] };
  return {
    calls: calls,
    CM6: {
      Decoration: {
        replace: function () {
          return { range: function (from, to) { return { from: from, to: to }; } };
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
    },
  };
}
/**
 * 假的 `EditorState`。
 * `tree` **显式传 `null`** ＝"解析器还没跑完"（`ensureSyntaxTree` 超时的那种首帧）。
 */
function stateOf(text, active, tree) {
  return {
    doc: { toString: function () { return text; } },
    active: active || [],
    tree: tree === undefined ? parse(text) : tree,
  };
}

test('⭐⭐ 接线：StateField 必须接到 `EditorView.decorations`（漏了就是"标记一个都藏不掉"）', function () {
  const f = fakeCM6();
  const ext = D.createField(f.CM6, { activeLineIndexes: function () { return []; } });
  assert.ok(Array.isArray(ext), '返回的必须是数组（调用方 `extensions.push(...)` 一次就够）');
  assert.strictEqual(ext.length, 2);
  assert.strictEqual(f.calls.from, 1, '`EditorView.decorations.from` 必须被调**恰好一次**');
  assert.strictEqual(f.calls.fromArg, ext[0], '接的必须是**同一个** field（⛔ 另建一份）');
  assert.strictEqual(ext[1].facetFrom, ext[0], '第二项必须是该 field 的 facet provider');
});

test('装饰集来自 `markers()`；**选区变了**要重算，什么都没变就原值返回', function () {
  const f = fakeCM6();
  const ext = D.createField(f.CM6, {
    activeLineIndexes: function (state) { return state.active; },
  });
  const field = ext[0];
  const built = field.create(stateOf('# 标题'));
  // ⚠️ **2** 条：① 标题的隐藏区间（`# `）② 行级品种类 `cm-rmd-h1`（`bugs/0015`）。
  assert.strictEqual(built.size, 2, '标题：1 个隐藏区间 ＋ 1 条行级品种类');
  // 光标移到第 0 行 ⇒ 该行显示源码 ⇒ 隐藏区间归零（规则 2）
  //    ⚠️ 但**行级品种类不跟着消失**：活动的意思是"标记不藏"，⛔ 不是"排版作废"
  //    —— 否则用户点进标题的那一下会看到字号先掉回正文（那是另一个"闪"）。
  const re = field.update(built, { docChanged: false, selection: {}, state: stateOf('# 标题', [0]) });
  assert.strictEqual(re.size, 1, '活动行只取消隐藏区间，行级品种类仍在');
  assert.strictEqual(re.decos[0].cls, 'cm-rmd-h1');
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
  const field = D.createField(f.CM6, { activeLineIndexes: function () { return []; } })[0];
  // 首帧：解析器还没跑完 ⇒ 可见降级（屏幕上看得见 `#`）
  const 未解析 = field.create(stateOf('# 标题', [], null));
  assert.strictEqual(未解析.size, 0, '没有树 ⇒ 一个区间、一条行级品种类都没有');
  // 解析完成 ⇒ 同一份文档、同一份选区，只是树换了
  const 解析完 = field.update(未解析, 树换了的假事务(stateOf('# 标题', [], null), stateOf('# 标题')));
  assert.strictEqual(解析完.size, 2, '树换了 ⇒ 隐藏区间 ＋ 标题行级品种类都回来');
  assert.deepStrictEqual(解析完.decos[0], { from: 0, to: 2 }, '`# ` 必须真的藏掉');
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

test('⭐ 活动行照样要算行级品种类（`activeLines` 只影响"藏不藏标记"）', function () {
  const p = marks('## 标题\n正文', { activeLines: [0, 1], bodyLines: true });
  assert.deepStrictEqual(p.ranges, [], '两行都活动 ⇒ 一个标记都不藏');
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
  const hooks = { activeLineIndexes: function () { return []; }, bodyLines: true };
  const field = D.createField(f.CM6, hooks)[0];
  const built = field.create(stateOf('## 标题\n正文'));
  assert.deepStrictEqual(f.calls.line, ['cm-rmd-h2', 'cm-rmd-body'], '两条行级品种类都要被建出来');
  const cls = built.decos.filter(function (d) { return d.cls; }).map(function (d) { return d.cls; });
  assert.deepStrictEqual(cls, ['cm-rmd-h2', 'cm-rmd-body']);
  // ⚠️ 块基线不是标题（段落 / 引用 / 代码块）⇒ 非标题行**不加**回落类，⛔ 别把正文也钉死
  const f2 = fakeCM6();
  const field2 = D.createField(f2.CM6, { activeLineIndexes: function () { return []; } })[0];
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
