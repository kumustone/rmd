// `design/0011` §7 的单测：**正文内查找的纯逻辑**（`src/services/find.js`）。
//
// ⭐ 这里测的**不是走树**（那要真 DOM，归 `tools/wkwebview-probe/find-probe.swift`
//    那组 10 条反例）而是**四条截断点的判据本身**、匹配口径、计数文案、
//    以及三个"跨文件不能漂开"的常量。
//
// ⚠️ 为什么判据要单独钉死：它们是本设计里**最容易写错、也最容易被"顺手优化"改坏**
//    的一段，而它们的失败面**全都不报错**——
//      · 漏一个块级标签 ⇒ 高亮跨了两个视觉块，看起来"莫名其妙"；
//      · 把 `pre` 里换行当排版空白 ⇒ **代码块里的换行消失**，正文却不再与源文件一致；
//      · 把 `<br>` 当成"没有东西" ⇒ `甲<br>乙` 拼成 `甲乙`，命中一个**屏幕上不存在**的词；
//      · 空偏移的问题同族：全部只在**语料恰好踩中**时才露出来。
//
// 跑法：`make test-js`（= `node --test tests/js/`）。
// ⚠️ 放在仓库根的 `tests/js/` 而不是 `src/`：`src/` 是 Tauri 的 `frontendDist`，
//    整个目录**会在编译期嵌进二进制**。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const F = require('../../src/services/find.js');

const ROOT = path.join(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────────
// ① 四条截断点的判据
// ─────────────────────────────────────────────────────────────────────────

test('排版空白_只有全空白且不在 pre 里才算', function () {
  // ⭐ 一手依据：comrak 的 `cr()` / `lf()` 会在标签排版之间写换行
  //    （`html.rs` 的 `render_table` 写完 `</table>` 后 `lf()`），
  //    ⇒ DOM 里会有**用户没写、也看不见**的文本节点。它们是分隔符，不进任何段。
  assert.strictEqual(F.isLayoutWhitespace('\n', false), true);
  assert.strictEqual(F.isLayoutWhitespace('   ', false), true);
  assert.strictEqual(F.isLayoutWhitespace('\n  \t\n', false), true);
  // ⚠️ 反例一：`<pre>` 里的换行是**可见内容**（`white-space` 保留它）⇒ ⛔ 不是排版空白。
  assert.strictEqual(F.isLayoutWhitespace('\n', true), false);
  assert.strictEqual(F.isLayoutWhitespace('    ', true), false);
  // ⚠️ 反例二：长度为 0 的节点**不算**截断点——它既不是空白也不是内容。
  //    当成截断点会在行内元素之间造出**假段边界**（`甲<em></em>乙` 被切成两段）。
  assert.strictEqual(F.isLayoutWhitespace('', false), false);
  // 普通文本当然不是。
  assert.strictEqual(F.isLayoutWhitespace('a', false), false);
  assert.strictEqual(F.isLayoutWhitespace(' a ', false), false);
  // ⚠️ 全角空格**也是**空白（`String.prototype.trim` 认它）——中文排版里它常出现，
  //    而 comrak 不会把它写进标签之间 ⇒ 它多半是用户真的打了，但也**确实看不见**。
  //    ⭐ 本设计取的是"全空白 ⇒ 不进段"，所以它同样被切掉；这一条钉住这个取舍。
  assert.strictEqual(F.isLayoutWhitespace('　', false), true);
});

test('块级标签白名单_含表格那一族_且不含行内元素', function () {
  // ⭐ 有了 TABLE 那一族，"每个单元格各自成段"是**自动**的——⛔ 不需要给单元格另写规则。
  ['p', 'li', 'td', 'th', 'table', 'thead', 'tbody', 'tfoot', 'tr',
    'pre', 'blockquote', 'h1', 'h6', 'ul', 'ol', 'dl', 'dt', 'dd'].forEach(function (t) {
    assert.strictEqual(F.isBlockTag(t), true, t + ' 应当是块级容器');
  });
  // ⛔ 行内元素**不是**段边界：`<p>索引<strong>回滚</strong>已生效</p>` 是**一段**。
  ['span', 'strong', 'em', 'code', 'a', 'sup', 'sub', 'mark', 'kbd', 'del', 'img'].forEach(function (t) {
    assert.strictEqual(F.isBlockTag(t), false, t + ' 不是块级容器');
  });
  // ⚠️ 大小写无关：`tagOf` 取的是 `nodeName.toLowerCase()`，而 HTML 里 `TD` 是大写。
  assert.strictEqual(F.isBlockTag('TD'), true);
  assert.strictEqual(F.isBlockTag(undefined), false);
});

test('br_自成一类截断点_不在块级白名单里', function () {
  // ⚠️⚠️ 这一条是**结构断言**，不是风格洁癖：`<br>` 与"块级容器"在**同一个函数里
  //    会互相遮蔽**——`consume()` 里那两条分支合并之后，注释就说不清
  //    「屏幕换了一行」与「进了一个新的视觉块」是两件事。
  //    ⭐ 更要紧的是它**不会报错**：`br` 若被塞进 `BLOCK_TAGS`，行为**恰好相同**
  //    （两条分支都只是 `cut()`）⇒ 谁把它挪进去都不会有症状，
  //    直到有人按"块级标签 = 会换行的标签"去理解这张表，再往里加 `wbr` / `hr`。
  assert.strictEqual(F.isBlockTag('br'), false);
  assert.strictEqual(F.BLOCK_TAGS.has('br'), false);
});

test('被排除子树只有_svg_与_math_两个根', function () {
  // ⭐ 排除的是**公式/图自身的内容**，⛔ 不是"含公式的整个段落"
  //    （`INV-FIND-10`：`<p>索引<math>…</math>回滚</p>` 里的 `索引`/`回滚` 照常可搜）。
  assert.strictEqual(F.isExcludedTag('svg'), true);
  assert.strictEqual(F.isExcludedTag('math'), true);
  // ⚠️ 反例：子树内部那些标签**不单独排除**——排除靠的是根的 `FILTER_REJECT` 整棵剪掉，
  //    逐个列出来意味着"漏一个就漏一处"，而漏了**没有任何症状**。
  ['path', 'g', 'mrow', 'mi', 'mo', 'annotation'].forEach(function (t) {
    assert.strictEqual(F.isExcludedTag(t), false, t + ' 靠根的剪枝覆盖，⛔ 不该单列');
  });
  assert.strictEqual(F.EXCLUDED_TAGS.size, 2);
});

// ─────────────────────────────────────────────────────────────────────────
// ② 关键词归一与匹配口径
// ─────────────────────────────────────────────────────────────────────────

test('关键词归一_只有空白等于没输入', function () {
  assert.strictEqual(F.normalizeQuery(''), '');
  assert.strictEqual(F.normalizeQuery('   '), '');
  assert.strictEqual(F.normalizeQuery('\t\n'), '');
  assert.strictEqual(F.normalizeQuery(null), '');
  assert.strictEqual(F.normalizeQuery(undefined), '');
  // ⭐ 非空白的关键词**原样返回**（⛔ 不 trim）：
  //    "索引 回滚"这种**带空格的短语**在段内是有意义的（同一段里的相邻两词），
  //    trim 掉两端会把用户明确打出来的空格悄悄改掉。
  assert.strictEqual(F.normalizeQuery(' a '), ' a ');
  assert.strictEqual(F.normalizeQuery('索引'), '索引');
});

test('匹配是非重叠的_与源域搜索同口径', function () {
  // ⚠️ `aaaa` 里搜 `aa` 是 **2** 处，⛔ 不是 3 处——"找完一处从它的结尾继续"。
  const h = F.matchAll(['aaaa'], 'aa');
  assert.deepStrictEqual(h, [
    { seg: 0, start: 0, end: 2 },
    { seg: 0, start: 2, end: 4 },
  ]);
});

test('匹配跨段走_段序与段内先后都对', function () {
  const h = F.matchAll(['甲甲甲', '乙', '甲'], '甲');
  assert.deepStrictEqual(h.map(function (x) { return [x.seg, x.start]; }), [[0, 0], [0, 1], [0, 2], [2, 0]]);
});

test('偏移是_UTF16_码元_Emoji 与中文都对', function () {
  // ⚠️ 这是本项目最容易静默错的一处（`design/0009` 的同族教训）：
  //    一个 Emoji 是 **1 个码点 / 2 个 UTF-16 码元 / 4 个 UTF-8 字节**，三种长度都不同。
  //    `Range` 用的是**码元** ⇒ 这里必须也是码元，否则高亮会**差半个字**。
  const h = F.matchAll(['😀回滚😀'], '回滚');
  assert.deepStrictEqual(h, [{ seg: 0, start: 2, end: 4 }]);
  const e = F.matchAll(['😀😀'], '😀');
  assert.deepStrictEqual(e, [{ seg: 0, start: 0, end: 2 }, { seg: 0, start: 2, end: 4 }]);
  // 中文一个字符 1 个码元（不是 3 字节）。
  assert.deepStrictEqual(F.matchAll(['索引回滚'], '回滚'), [{ seg: 0, start: 2, end: 4 }]);
});

test('空关键词与搜不到都给空结果', function () {
  assert.deepStrictEqual(F.matchAll(['甲乙', '丙'], ''), []);
  assert.deepStrictEqual(F.matchAll(['甲乙', '丙'], '   '), []);
  assert.deepStrictEqual(F.matchAll(['甲乙', '丙'], '丁'), []);
  assert.deepStrictEqual(F.matchAll([], '甲'), []);
  assert.deepStrictEqual(F.matchAll(null, '甲'), []);
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 上限只截高亮_⛔ 不截计数
// ─────────────────────────────────────────────────────────────────────────

test('上限是_2000_并且它只截视觉标记', function () {
  // ⚠️⚠️ 这个数**不是随手定的**（`INV-FIND-05`）：它同时是"每次输入刷新 ≤ 50 ms"
  //    这条判据的**前提**——实测 40 万处全亮 **360–438 ms**，
  //    而限在 2000 处只要 **1–2 ms**，**计数扫描一个字没少**（`research/notes/0015` §5）。
  //    ⇒ 想动它，得连 `design/0011` §7 步骤 0c 的判据 ② 一起重拍。
  assert.strictEqual(F.HIGHLIGHT_CAP, 2000);

  const few = F.clampHits([1, 2, 3], F.HIGHLIGHT_CAP);
  assert.deepStrictEqual(few, { shown: 3, total: 3, truncated: false });

  const many = F.clampHits(new Array(2001), F.HIGHLIGHT_CAP);
  assert.deepStrictEqual(many, { shown: 2000, total: 2001, truncated: true });

  // ⚠️ 边界上恰好相等时**不算**截断（`<=` 不是 `<`）——否则浮层会白挂一句
  //    "已高亮前 2000 处"，而实际一处没少。
  assert.strictEqual(F.clampHits(new Array(2000), F.HIGHLIGHT_CAP).truncated, false);
  // 自定义 cap（单测与将来调参用）。
  assert.deepStrictEqual(F.clampHits([1, 2, 3], 1), { shown: 1, total: 3, truncated: true });
  // cap = 0 是合法值（"一个都不亮，只报数"）。
  assert.deepStrictEqual(F.clampHits([1], 0), { shown: 0, total: 1, truncated: true });
  assert.deepStrictEqual(F.clampHits([], 0), { shown: 0, total: 0, truncated: false });
});

test('上限说明_两个数都要在', function () {
  assert.strictEqual(F.capNote(3, 3), '');                     // 没截断 ⇒ 不说
  assert.strictEqual(F.capNote(2001, 2000), '共 2 001 处，已高亮前 2 000 处');
  assert.strictEqual(F.capNote(12000, 2000), '共 12 000 处，已高亮前 2 000 处');
});

// ─────────────────────────────────────────────────────────────────────────
// ④ 「第几个 / 共几个」与环绕
// ─────────────────────────────────────────────────────────────────────────

test('推进_两端都要环绕', function () {
  assert.strictEqual(F.step(0, 3, 1), 1);
  assert.strictEqual(F.step(2, 3, 1), 0);    // 末尾 → 回到第一个
  assert.strictEqual(F.step(0, 3, -1), 2);   // 开头 → 跳到最后
  assert.strictEqual(F.step(1, 3, -1), 0);
  // ⚠️ `cur = -1`（"还没有当前"）两边都要给出有意义的下标：
  //    下一个 → 0，上一个 → 最后那个。⛔ 不能返回 -1（那会让界面显示"第 0 个"）。
  assert.strictEqual(F.step(-1, 3, 1), 0);
  assert.strictEqual(F.step(-1, 3, -1), 2);
  // 没有命中时**永远**是 -1（⛔ 不是 0）。
  assert.strictEqual(F.step(0, 0, 1), -1);
  assert.strictEqual(F.step(-1, 0, -1), -1);
  // 越界的 cur 也要能给回一个合法值（索引可能在两次运行之间变过）。
  assert.strictEqual(F.step(99, 3, 1), 0);
  assert.strictEqual(F.step(99, 3, -1), 2);
});

test('计数文案_无结果时不给数字', function () {
  // ⚠️ `INV-FIND-05` 后半条：**无结果不是 `0 / 0`**——那看起来像"还没算完"。
  assert.strictEqual(F.countText(-1, 0), '无结果');
  assert.strictEqual(F.countText(0, 0), '无结果');
  assert.strictEqual(F.countText(0, 5), '1 / 5');
  assert.strictEqual(F.countText(4, 5), '5 / 5');
  // ⚠️ 千位分隔用**空格**：中文正文里夹一个逗号会与句读混起来。
  assert.strictEqual(F.countText(0, 2000), '1 / 2 000');
  assert.strictEqual(F.countText(999, 1000), '1 000 / 1 000');
});

test('千位分隔用空格', function () {
  assert.strictEqual(F.group(0), '0');
  assert.strictEqual(F.group(12), '12');
  assert.strictEqual(F.group(999), '999');
  assert.strictEqual(F.group(2000), '2 000');
  assert.strictEqual(F.group(1234567), '1 234 567');
});

// ─────────────────────────────────────────────────────────────────────────
// ⑤ 冒烟自证用的两个件
// ─────────────────────────────────────────────────────────────────────────

test('探测词取前几个码点_不切碎代理对且不跨空白', function () {
  // ⭐ 冒烟要一个"**一定存在于这份文档里**"的关键词 ⇒ 从正文第一段现取。
  assert.strictEqual(F.probeQueryText('索引与回滚都已生效', 4), '索引与回');
  // ⚠️ 到**词尾就停**：跨空白的片段在"可见文本"里可能被排版空白切开了。
  assert.strictEqual(F.probeQueryText('索引 回滚', 4), '索引');
  // 前导空白先跳过。
  assert.strictEqual(F.probeQueryText('   回滚', 2), '回滚');
  // ⚠️⚠️ **不许从代理对中间切开**：切出半个 Emoji 的关键词**永远匹配不上**，
  //    而那会被误读成"查找坏了"（其实是探测件自己的 bug）。
  const q = F.probeQueryText('😀😀😀😀😀', 4);
  assert.strictEqual(q, '😀😀😀😀');
  assert.strictEqual(q.length, 8);                     // 4 个码点 = 8 个 UTF-16 码元
  assert.strictEqual(Array.from(q).length, 4);
  // 全空白 / 空串 ⇒ 空串（调用方要**响亮**处理：那是"这篇文档里取不出探测词"）。
  assert.strictEqual(F.probeQueryText('    \n', 4), '');
  assert.strictEqual(F.probeQueryText('', 4), '');
  assert.strictEqual(F.probeQueryText(null, 4), '');
});

test('哨兵词在任何正常文本上都搜不到', function () {
  // ⭐ 它的作用是当**反面对照**：只验"搜到了"会被一个"永远返回命中"的实现骗过。
  assert.ok(F.PROBE_SENTINEL.length > 0);
  // ⚠️ 它**不能**被 `normalizeQuery` 吃掉（那就成了"搜空串、当然 0 处"——判据失效）。
  assert.strictEqual(F.normalizeQuery(F.PROBE_SENTINEL), F.PROBE_SENTINEL);
  assert.strictEqual(F.matchAll(['索引与回滚都已生效', '第二段文字'], F.PROBE_SENTINEL).length, 0);
  // ⚠️ 也别把它设计成"含空白 ⇒ 归一后为空"。
  assert.strictEqual(F.PROBE_SENTINEL.trim(), F.PROBE_SENTINEL);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑥ 跨文件的三个常量：⛔ 不许两边各写一份
// ─────────────────────────────────────────────────────────────────────────

test('两档高亮名与_find.css_逐字相同', function () {
  // ⚠️ 这一条**不在 JS 内部能看出来**：`CSS.highlights` 的键与 `::highlight()` 里的
  //    名字是**两个文件里各写一遍的字符串**。改一边、忘另一边 =
  //    高亮**一处都不出现**，而 `CSS.highlights.set` 不报错、控制台什么也不说。
  //    ⇒ 把 `find.js` 的常量读出来，去 CSS 里找 `::highlight(<名字>)`。
  const css = fs.readFileSync(path.join(ROOT, 'src/styles/find.css'), 'utf8');
  [F.HL_ALL, F.HL_CURRENT].forEach(function (name) {
    assert.ok(css.indexOf('::highlight(' + name + ')') >= 0,
      'find.css 里没有 `::highlight(' + name + ')` —— 高亮会**一处都不出现**且不报错');
  });
  // ⭐ 顺带钉住两个名字在 CSS 里**不是**同一个（写成一样的话第二档会覆盖第一档）。
  assert.notStrictEqual(F.HL_ALL, F.HL_CURRENT);
});

test('两档的语义变量在_find.css_里都引用到了', function () {
  // ⭐ 同族：变量名也是两边各写一遍的字符串（`INV-THEME-02` 要的是"有出处"，
  //    ⛔ 不是"名字对了就行"）。写错一个名字 ⇒ `var()` 静默落空 ⇒ 那一处**没底/没字色**。
  const css = fs.readFileSync(path.join(ROOT, 'src/styles/find.css'), 'utf8');
  ['--reader-find-hit-bg', '--reader-find-hit-text',
    '--reader-find-current-bg', '--reader-find-current-text'].forEach(function (v) {
    assert.ok(css.indexOf('var(' + v + ')') >= 0, 'find.css 没有引用 ' + v);
  });
});

test('段判据只有一份实现_findbar_里不许再写一遍', function () {
  // ⭐ 这是 `INV-SEARCH-02`（"共用谓词"）在本次的正身：走树那半必须**调**这里的判据，
  //    ⛔ 不能照着抄一份。抄一份的下场是两份慢慢分叉——
  //    而分叉**不会有任何症状**，只是"有时候高亮跨了块"。
  const bar = fs.readFileSync(path.join(ROOT, 'src/components/FindBar.js'), 'utf8');
  ['isLayoutWhitespace', 'isBlockTag', 'isExcludedTag', 'normalizeQuery', 'matchAll', 'clampHits']
    .forEach(function (fn) {
      // ⛔ 只许**调用**（`F.isBlockTag(`），⛔ 不许**定义**（`function isBlockTag(`）。
      assert.ok(bar.indexOf('function ' + fn) < 0,
        'FindBar.js 里又写了一遍 ' + fn + ' —— 判据必须只有一份（find.js）');
      assert.ok(bar.indexOf('F.' + fn) >= 0,
        'FindBar.js 没有调用 F.' + fn + '（那说明它自己另写了一份）');
    });
});

test('find_js_里没有按键字面量', function () {
  // ⚠️ 与 `keymap.test.js` 那条源码级闸门**同一条纪律**，这里只补一份**就近**的：
  //    键位显示一律走 `main.js` 的 `accelText(id)` 从后端表取（`INV-SET-01`）。
  const src = fs.readFileSync(path.join(ROOT, 'src/services/find.js'), 'utf8');
  assert.strictEqual(/\b(Cmd|Ctrl|Shift|Alt|Command)\s*\+/.test(src), false);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑦ 搜索范围那句话：⭐ 它是"用户裁定要有的"，而**掉了看不出来**
// ─────────────────────────────────────────────────────────────────────────

test('⭐ 搜索范围那句常驻在浮层说明行上（⛔ 且只有一份文案）', function () {
  // ⚠️ 这条闸门守的是**静默失效**：`INV-FIND-04` 把搜索域定成渲染结果 ⇒ 源码里的
  //    `##`/`**`、链接 URL 搜不到，而**界面上不会有任何报错**——用户只会以为查找坏了。
  //    2026-10-16 用户裁定"接受只搜渲染预览，但界面要明确提示范围"。
  //    ⇒ 若有人后来把这一行删了 / 挪进"搜不到时才出现"的分支，**没有任何东西会报错**。
  const bar = fs.readFileSync(path.join(ROOT, 'src/components/FindBar.js'), 'utf8');
  assert.ok(typeof F.SCOPE_HINT === 'string' && F.SCOPE_HINT.length > 0,
    '`find.js` 没有导出 SCOPE_HINT');
  assert.ok(F.SCOPE_HINT.indexOf('渲染') >= 0,
    '范围那句话必须点名"渲染" —— 它是判据本身，⛔ 不能写成"搜索正文"这种含糊说法');
  // ⛔ 只许**取**，不许**另写一份**（同 `HL_ALL` 那条的纪律）。
  // ⚠️ 2026-10-21 口径**原地改过**（`design/0025` §2.5.1 ②）：界面侧现在取的是
  //    **字典键** `F.SCOPE_HINT_KEY`（再 `t()` 一次），⛔ 不是 `F.SCOPE_HINT` 那个
  //    加载期常量——拿常量上屏就**冻住了语言**。判据本身没变：**文案只有一份**
  //    （`SCOPE_HINT` 是中文原文锚点，`i18n.test.js` 有一条钉住它与字典逐字相等）。
  assert.ok(typeof F.SCOPE_HINT_KEY === 'string' && F.SCOPE_HINT_KEY.length > 0,
    '`find.js` 没有导出 SCOPE_HINT_KEY');
  assert.ok(bar.indexOf('F.SCOPE_HINT_KEY') >= 0,
    'FindBar.js 没有把范围那句话放上界面（`F.SCOPE_HINT_KEY`）');
  assert.ok(bar.indexOf('范围：') < 0,
    'FindBar.js 里又写了一份范围文案 —— 文案只能有一份（`find.js`）');
});

test('⚠️ 上面那条闸门本身是活的（拿诱饵问判据，⛔ 不是问常量上有几个字符）', function () {
  // ⚠️ 与 `keymap.test.js` 的「闸门本身是活的」同一条纪律：只断言"当前有这一句"
  //    挡不住判据被改宽（例如把 `indexOf('渲染')` 放宽成 `length > 0`
  //    ⇒ "搜索正文"这种**没说出关键**的文案也会全绿）。
  const 含糊 = '范围：搜索正文';
  assert.strictEqual(含糊.indexOf('渲染') >= 0, false,
    '⛔ 判据认不出"没点名渲染"的文案');
  assert.strictEqual('范围：渲染后的正文（不含 Markdown 源码标记）'.indexOf('渲染') >= 0, true,
    '⛔ 判据连正牌文案都认不出');
});
