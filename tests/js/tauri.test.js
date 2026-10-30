// `src/services/tauri.js` 的单测：⭐ **`Denied` 这两个半边的契约对账**。
//
// # 为什么这个文件存在
//
// `KIND_KEY`（前端那张**键表**）与 `error.rs` 的 `Denied`（后端）是**一份契约的两半**：
// 后端说 `kind`，前端把它指到一个字典键、再由 `services/i18n.js` 翻成人话。
// ⚠️ 两半分开演进、**没有任何编译期联系**
// ——后端加一个变体，前端那张表**不会红**，只是那一类掉进兜底。
//
// ⛔ 而兜底那句 `'操作失败'` 的语义是「**我们不定义原因**」（见文件头的注释）。
// 拿它去说一个**已知**的前置条件，是把用户推向错方向：
// 2026-10-16 用户按 `⌘E`（当时没有打开任何文档）拿到「打不开外部编辑器：**操作失败**」，
// 真实原因是后端明明白白回的 `no_document`（`docs/bugs/0005`）。
//
// ⇒ ⭐ 本文件的主闸门**从后端源码里抠出 `kind` 标签**，逐个对账前端那张表。
//    ⚠️ 它守的是"**下一类**也别忘了"——这类缺陷的形态是"后端加一类、前端没跟"，
//    修完 `no_document` 并不代表不会再发生一次。
//
// ⭐ 第 ⑤ 节是同一件事的**另一半**（`docs/bugs/0005` 的入口那半）：`⌘E` 的入口
//    必须先看 `S.state.currentDoc` 再决定发不发那条 IPC ——⛔ 别让它退回去
//    "把'没有文档'整件事推给后端、拿后端的拒绝当提示语"。
//
// ⚠️ 为什么是**源码级**闸门：`error.rs` 是 Rust，node 里跑不起来。
//    同族先例：`tests/js/keymap.test.js` 的「脚本加载顺序」、
//    `tests/js/editor.test.js` 末尾那条「`main.js` 必须接上 `markEdited`」。
//    ⭐ 这个项目已经有三条同形态的闸门，它们的共同点是：**错的那一半进不了两边的测试**。
//
// ⚠️ 纯逻辑、无 DOM（`resolveInvoke`／`listen` 那几条自己铺一个假 `window`）⇒ 可 `node --test`。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const T = require('../../src/services/tauri.js');

// ⭐ `design/0025`（2026-10-21）：`tauri.js` 那张表**不再存中文**，只存**字典键**（`KIND_KEY`）。
// ⇒ 本文件的硬比较一律先过一道「键 → 中文」，而那一道**直接用产品那本字典**
//   （`services/i18n.js` 的 `DICT.zh`），⛔ 不在这里另抄一份中文——
//   另抄一份的话，"文案改了、断言没跟"会**静默变绿**，那正是 `docs/bugs/0005` 那一族的下一形态。
const I18N = require('../../src/services/i18n.js');
const ZH = I18N.DICT.zh;
const EN = I18N.DICT.en;

/** 键 → 中文。⚠️ 与产品在浏览器里走的是**同一本**字典（`window.rmd.i18n.t`）。 */
function 中文(k) { return ZH[k]; }

/** 前端那张键表的**全部取值** ＋ 兜底键（按 `KIND_KEY` / `OTHER_KEY` 的当前内容现算）。 */
function 全部键() {
  return Object.keys(T.KIND_KEY).map(function (k) { return T.KIND_KEY[k]; }).concat([T.OTHER_KEY]);
}

const 仓库根 = path.join(__dirname, '..', '..');
const ERROR_RS = path.join(仓库根, 'src-tauri', 'src', 'error.rs');

// ─────────────────────────────────────────────────────────────────────────
// 从 `error.rs` 里抠标签（⛔ 只干这一件事，判据在下面）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 剥掉 Rust 注释。⚠️ **必须先剥**：`error.rs` 的文档注释里**大量出现**
 * `Denied::Conflict` / `Denied::SaveInFlight` 这类 `[]` 链接，
 * 不剥的话"扫到的变体集合"里混进来的全是注释里的名字 ⇒ 闸门**看起来更严**、
 * 实际上被注释**伪造**了（有人只改注释就能让它变绿）。
 *
 * ⚠️ 够用即可：本文件没有嵌套块注释（Rust 允许，但真出现时这条会**保守地**报红，
 * 那是安全的方向——⛔ 别为了"更正确"在这里写一个 Rust 词法分析器）。
 */
function 剥注释(源码) {
  return 源码
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/**
 * 抠出 `pub enum Denied { … }` 的**枚举体**（花括号配平地走到收尾）。
 * @returns {{ 体: string, 属性: string, 结束位置: number }}
 */
function 抠枚举体(源码) {
  const code = 剥注释(源码);
  const m = /pub\s+enum\s+Denied\s*\{/.exec(code);
  assert.ok(m, '⛔ `error.rs` 里找不到 `pub enum Denied {` —— 闸门失效了，别放宽它，先看文件');

  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  assert.strictEqual(depth, 0, '⛔ `Denied` 的枚举体没配平 —— 抠出来的东西不可信');

  // ⚠️ 紧挨着的那条 `#[serde(...)]`：`kind` 与 `rename_all` 的**取值**是
  //    "变体名 → 标签"这条换算的全部依据，⛔ 不许默默假设。
  const 前面 = code.slice(Math.max(0, m.index - 400), m.index);
  const 属性们 = 前面.match(/#\[serde\([^)]*\)\]/g) || [];
  return { 体: code.slice(start, i - 1), 属性: 属性们[属性们.length - 1] || '', 结束位置: i };
}

/** 按**顶层**逗号切开枚举体（⚠️ 变体自带的 `{}` 里的逗号不算）。 */
function 顶层项(体) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of 体) {
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** `NotAuthorized` → `not_authorized`（serde 的 `rename_all = "snake_case"`）。 */
function 蛇形(名) {
  return 名.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * ⭐ 从 `error.rs` 抠出**后端真正会发出去的 `kind` 标签**。
 *
 * ⚠️ 标签的**权威**是 serde 的属性（`tag = "kind"` ＋ `rename_all`），
 * ⛔ 不是"我们记得的那 7 个名字"——照抄一份常量进来的话，
 * 后端加了变体而这份常量没加时，闸门照样绿（那就成了**第三份**真值）。
 */
function 抠标签(源码) {
  const { 体, 属性 } = 抠枚举体(源码);
  assert.ok(/tag\s*=\s*"kind"/.test(属性), '⛔ `Denied` 的 serde 属性里没有 `tag = "kind"` —— 前端按 `kind` 分支的前提变了');
  assert.ok(
    /rename_all\s*=\s*"snake_case"/.test(属性),
    '⛔ `rename_all` 不是 `snake_case` —— 本文件的"变体名 → 标签"换算就不再成立，⛔ 别猜，先改换算'
  );

  const 标签 = [];
  for (const 项 of 顶层项(体)) {
    const 净 = 项.replace(/^\s*(?:#\[[^\]]*\]\s*)*/, '');
    const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(净);
    if (!m) continue;
    // ⚠️ 变体自己写了 `#[serde(rename = "…")]` 时以它为准（本文件当前没有，但别埋雷）。
    const r = /#\[serde\([^)]*rename\s*=\s*"([^"]+)"/.exec(项);
    标签.push(r ? r[1] : 蛇形(m[1]));
  }
  return 标签;
}

/**
 * ⭐ **裸判据**：把"抠出来的变体名"与**同一个文件里另外两处枚举**对账
 * （`label()` 与 `Display` 的 `match` 臂，都写成 `Denied::Xxx`）。
 *
 * ⚠️ 为什么需要它：`抠标签` 是个**扫描**，而扫描的失败形态是**静默少扫几个**
 * ——少扫掉的标签不会出现在结果里，于是"每一个都有对应文案"变成一句空话。
 * ⇒ 三处枚举互为对照，**任一处少一个就报红**。
 * ⭐ 这也顺手钉住了另一件事：`label()`/`Display` 里漏一个变体，Rust 侧**编译不过**
 * （match 穷尽性）⇒ 它们就是"当前到底有几个变体"的**可信**来源。
 */
function 对账变体数(源码) {
  const { 体, 结束位置 } = 抠枚举体(源码);
  const 枚举里的 = new Set(顶层项(体).map(function (项) {
    const m = /^\s*(?:#\[[^\]]*\]\s*)*([A-Za-z_][A-Za-z0-9_]*)/.exec(项);
    return m ? m[1] : null;
  }).filter(Boolean));

  const 别处的 = new Set();
  const 尾巴 = 剥注释(源码).slice(结束位置);
  // ⚠️ **只要首字母大写**的：`impl Denied` 里那几个构造器是**小写**的
  //    （`Denied::not_authorized("…")`，`error.rs:98` 起那一段），
  //    它们**不是变体名**——不排掉的话，"变体集合"里会混进一组同名的构造器，
  //    于是"少扫一个变体"永远被构造器补齐 ⇒ 这条对账**永远绿**。
  //    （Rust 的变体名按约定是 PascalCase；本 crate 没有 `non_camel_case_types` 例外。）
  for (const m of 尾巴.matchAll(/Denied::([A-Z][A-Za-z0-9_]*)/g)) 别处的.add(m[1]);

  const 只在枚举 = [...枚举里的].filter(function (n) { return !别处的.has(n); });
  const 只在别处 = [...别处的].filter(function (n) { return !枚举里的.has(n); });
  return { 枚举里的: 枚举里的, 别处的: 别处的, 只在枚举: 只在枚举, 只在别处: 只在别处 };
}

/** ⭐ **裸判据**：哪几个标签在前端那张表里没有格子。 */
function 缺谁(标签们, 词表) {
  return 标签们.filter(function (t) {
    return !Object.prototype.hasOwnProperty.call(词表, t);
  });
}

// ═════════════════════════════════════════════════════════════════════════
// ① 闸门的**自身**可信度（先证扫描不是空转，再谈对账）
// ═════════════════════════════════════════════════════════════════════════

const 源码 = fs.readFileSync(ERROR_RS, 'utf8');

test('⭐ 闸门自证①：三处枚举同一个集合（扫描没少扫、也没被注释伪造）', function () {
  const r = 对账变体数(源码);
  assert.deepStrictEqual(r.只在枚举, [], '⛔ 这几个变体只出现在枚举体里，`label()`/`Display` 里没有：' + r.只在枚举.join('、'));
  assert.deepStrictEqual(r.只在别处, [], '⛔ 这几个变体只在别处出现、枚举体里没有：' + r.只在别处.join('、'));
  // ⚠️ 下界写死一个**很小**的数，只为挡住"扫出来是空集"这一种空转
  //    （真正的判据是上面那两条集合相等）。⛔ 别把它改成"等于 7"——
  //    那样后端加一类时这条会红，而加一类**本来是该发生的事**。
  assert.ok(r.枚举里的.size >= 4, '⛔ 只抠到 ' + r.枚举里的.size + ' 个变体，扫描八成坏了');
});

test('⭐ 闸门自证②：`抠标签` 抠出来的就是后端会发的那几个（含属性换算）', function () {
  const 标签 = 抠标签(源码);
  // ⭐ 这几条是**换算正确性**的钉子（⛔ 不是"我抄一份清单"）：
  //    多词驼峰 → 下划线，是 serde 的 `rename_all = "snake_case"` 干的。
  assert.ok(标签.indexOf('save_in_flight') >= 0, '`SaveInFlight` 没换算成 `save_in_flight`：' + 标签.join('、'));
  assert.ok(标签.indexOf('not_authorized') >= 0, '`NotAuthorized` 没换算成 `not_authorized`：' + 标签.join('、'));
  assert.ok(标签.indexOf('io') >= 0, '`Io` 没换算成 `io`：' + 标签.join('、'));
  // ⚠️ 反面判据：⛔ 别把**变体名**漏出来（漏出来说明换算没跑，就等于没对账）。
  assert.ok(标签.indexOf('SaveInFlight') < 0, '⛔ 抠出来的是驼峰变体名，不是 serde 标签 —— 换算没生效');
  assert.strictEqual(new Set(标签).size, 标签.length, '⛔ 抠出来的标签有重复：' + 标签.join('、'));
});

test('⭐ 闸门自证③（诱饵）：把枚举体削短，`对账变体数` 必须报红', function () {
  // ⚠️ 这条证明的是"**扫描变窄**这件事会被抓住"——这正是"后端加一类、
  //    扫描却漏掉它"的那条路。⛔ 没有它，上面那些断言可能只是**看起来**在守。
  const 削短 = 源码.replace(/SaveInFlight\s*\{[\s\S]*?\n\s*\},/, '');
  assert.notStrictEqual(削短, 源码, '⛔ 诱饵没生效：那段变体没被削掉，这条自证是假的');
  const r = 对账变体数(削短);
  assert.deepStrictEqual(r.只在别处, ['SaveInFlight'], '⛔ 枚举体被削短了却没报红 —— 对账是空转的');
});

// ═════════════════════════════════════════════════════════════════════════
// ② 主闸门：两半对账
// ═════════════════════════════════════════════════════════════════════════

test('⭐⭐ 契约对账：后端每一个 `kind` 前端都有格子（`docs/bugs/0005`）', function () {
  const 标签 = 抠标签(源码);
  const 缺的 = 缺谁(标签, T.KIND_KEY);
  assert.deepStrictEqual(
    缺的,
    [],
    '⛔ 后端会发这些 `kind`，前端 `KIND_KEY` 里却没有格子：' + 缺的.join('、') +
      ' —— 它们会掉进兜底的 `err.kind.other`（含义是"我们不定义原因"，' +
      '用在**已知**的拒绝上等于把用户推向错方向，`docs/bugs/0005`）'
  );
});

test('⭐ 诱饵：从键表里删掉 `no_document`，对账必须报红', function () {
  // ⚠️ 上一条的**反面**：证明"少一格"这件事真的会被抓住。
  //    它就是 2026-10-16 用户按 `⌘E` 时那份代码的形态。
  const 词表 = Object.assign({}, T.KIND_KEY);
  delete 词表.no_document;
  assert.deepStrictEqual(缺谁(抠标签(源码), 词表), ['no_document'], '⛔ 少一格却没被抓住');
});

test('⭐ 反向：键表里⛔ 不许有后端根本不会发的格子', function () {
  // ⚠️ 多出来的格子是**另一种**漂移：它看着像保护，实际上是"后端把这个 `kind`
  //    改名了，而前端还在等那个旧名字"——同样是一次静默的失配。
  const 标签 = new Set(抠标签(源码));
  const 多的 = Object.keys(T.KIND_KEY).filter(function (k) { return !标签.has(k); });
  assert.deepStrictEqual(多的, [], '⛔ 前端有这些格子，但后端不会发这些 `kind`：' + 多的.join('、'));
});

test('⭐ 键表装的是**键**，⛔ 不是中文（`design/0025` 的形态判据）', function () {
  // ⚠️ 这条挡的是"顺手把中文填回去"——那样换了语言这七句会永远停在中文，
  //    而且**没有任何报错**（`INV-I18N-01` 的典型形态）。
  const 键们 = 全部键();
  assert.ok(键们.length >= 2, '⛔ 只取到 ' + 键们.length + ' 个键 —— 表空了');
  for (const 键 of 键们) {
    assert.strictEqual(typeof 键, 'string', '⛔ 表里混进了非字符串：' + String(键));
    assert.ok(!/[一-鿿]/.test(键), '⛔ 值里有汉字 —— 中文又回到 `tauri.js` 了：' + 键);
    assert.strictEqual(键.indexOf('err.kind.'), 0, '⛔ 键不在 `err.kind.*` 命名空间下：' + 键);
    assert.ok(Object.prototype.hasOwnProperty.call(ZH, 键), '⛔ `' + 键 + '` 不在中文那本字典里');
    assert.ok(Object.prototype.hasOwnProperty.call(EN, 键), '⛔ `' + 键 + '` 不在英文那本字典里');
  }
});

test('⭐ 文案质量：不许有空格子，也不许拿兜底那句去顶（⭐ 两本字典都要）', function () {
  // ⚠️ 中文那本是**回落目标**（`INV-I18N-02` 的链条：当前语言 → 中文 → key），
  //    所以它空格子的代价是**两种语言都**没有这一句。
  for (const 语言 of ['zh', 'en']) {
    const 本 = I18N.DICT[语言];
    const 兜底 = 本[T.OTHER_KEY];
    assert.ok(typeof 兜底 === 'string' && 兜底, '⛔ `' + 语言 + '` 的兜底键 `' + T.OTHER_KEY + '` 没有文案');
    for (const 种 of Object.keys(T.KIND_KEY)) {
      const 词 = 本[T.KIND_KEY[种]];
      assert.ok(typeof 词 === 'string' && 词.trim().length >= 2, '⛔ `' + 语言 + '` 的 `' + T.KIND_KEY[种] + '` 的文案是空的');
      assert.notStrictEqual(词, 兜底, '⛔ `' + 语言 + '` 的 `' + T.KIND_KEY[种] + '` 挂着兜底那句 —— 有格子等于没格子');
    }
  }
});

test('⭐⭐ `no_document` ⛔ 不许说成 `not_found`（`design/0006` §10.6 第 6 条）', function () {
  // ⚠️ 原文的理由：「文案含义不同——『你打开的那个目录/文件找不到了』vs『现在根本没有
  //    当前文档』…合成一类会让前端把后者显示成『文件被删了』」。
  //    ⇒ 这条不钉"有没有格子"，钉的是**两句话确实不同**（⚠️ 两本字典各判一次：
  //    只在中文里不同、英文里合流，英文用户照样被指向错方向）。
  for (const 语言 of ['zh', 'en']) {
    const 本 = I18N.DICT[语言];
    const 无 = 本[T.KIND_KEY.no_document];
    assert.notStrictEqual(
      无,
      本[T.KIND_KEY.not_found],
      '⛔ `' + 语言 + '`：`no_document` 与 `not_found` 说了同一句话 —— 用户会去找一个根本没丢的文件'
    );
    // ⚠️ 也不许说成"读写失败"：`NoDocument` 的文档写明「不是读取失败，是**前置条件不满足**」。
    assert.notStrictEqual(无, 本[T.KIND_KEY.io], '⛔ `' + 语言 + '`：`no_document` 说成读写失败了');
  }
});

// ═════════════════════════════════════════════════════════════════════════
// ③ `normalizeError` 的兜底语义（⛔ 别把兜底"改好"成猜一个原因）
// ═════════════════════════════════════════════════════════════════════════

test('⭐ 认不出来的 `kind` 一律兜底，⛔ 不猜成任何具体原因', function () {
  const e = T.normalizeError({ kind: '某个还不存在的拒绝', path: '/x' });
  assert.strictEqual(e.kind, '某个还不存在的拒绝', '`kind` 要原样留着（排查时靠它）');
  assert.strictEqual(e.path, '/x');
  // ⚠️ node 里没有 `window.rmd.i18n` ⇒ `wording` **回落成键本身**
  //    （与 `i18n.t()` 的"两本都缺 ⇒ 显示 key"同一条纪律：可见、不静默，
  //    ⛔ 不给一个编出来的中文）。
  assert.strictEqual(e.wording, T.OTHER_KEY, '⛔ 没有翻译器时必须如实回落成键，⛔ 别自己编一句');
  // ⭐ 注入中文翻译器之后才是用户看到的那句。
  const 中 = T.normalizeError({ kind: '某个还不存在的拒绝' }, 中文);
  assert.strictEqual(中.wording, '操作失败', '⭐ 兜底那句的语义是「我们不定义原因」');
  // ⚠️ 反面判据：兜底⛔ 不许变成"读取失败"这类**编出来的**原因。
  //    ⚠️⚠️ 比的是**翻译之后**的词，⛔ 别拿键去比键——两串键必然不同，那样等于没判。
  assert.notStrictEqual(中.wording, 中文(T.KIND_KEY.io), '⛔ 兜底替一个未知失败编了一个读写原因');
  assert.notStrictEqual(中.wording, 中文(T.KIND_KEY.not_found), '⛔ 兜底把"我们自己的 bug"说成"文件不存在"');
});

test('`normalizeError`：形状稳（字符串/空值都不炸）', function () {
  assert.strictEqual(T.normalizeError('磁盘满了').kind, 'other');
  assert.strictEqual(T.normalizeError('磁盘满了').message, '磁盘满了');
  assert.strictEqual(T.normalizeError('磁盘满了').wording, T.OTHER_KEY);
  for (const 空 of [null, undefined, 0, false]) {
    const e = T.normalizeError(空);
    assert.strictEqual(e.kind, 'other', '`' + String(空) + '` 应归 `other`');
    assert.strictEqual(e.wording, T.OTHER_KEY);
    assert.strictEqual(e.raw, 空, '`raw` 要留住原始值');
  }
  // ⭐ 注入翻译器之后，**所有**这些也都得有那句话（⛔ 别只在"认得出来"的分支里翻译）。
  for (const 空 of ['磁盘满了', null, { kind: 'stale' }, { kind: '不存在的' }]) {
    const e = T.normalizeError(空, 中文);
    assert.ok(typeof e.wording === 'string' && e.wording, '⛔ 注入翻译器后 `wording` 空了：' + JSON.stringify(空));
    assert.ok(!/[一-鿿]/.test(T.OTHER_KEY) && e.wording !== T.OTHER_KEY, '⛔ 注入翻译器后没翻：' + JSON.stringify(空));
  }
  assert.strictEqual(T.normalizeError({ kind: 'stale', got: 1 }).kind, 'stale');
});

test('`isStale` / `isNotAuthorized` 只认自己那一个 `kind`', function () {
  assert.strictEqual(T.isStale({ kind: 'stale' }), true);
  assert.strictEqual(T.isStale({ kind: 'conflict' }), false);
  assert.strictEqual(T.isStale(null), false);
  assert.strictEqual(T.isNotAuthorized({ kind: 'not_authorized' }), true);
  assert.strictEqual(T.isNotAuthorized({ kind: 'not_found' }), false);
  assert.strictEqual(T.isNotAuthorized(undefined), false);
});

// ═════════════════════════════════════════════════════════════════════════
// ④ `call` —— ⭐ 用户报的那条路（`⌘E` → reject → 状态条）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 铺一个假 `window.__TAURI__`，返回还原函数。⚠️ `node --test` 一个文件一个进程，污染不外溢。
 *
 * @param {object} 形状 `__TAURI__` 的假体
 * @param {boolean} [带字典] ⭐ 是否同时铺上 `window.rmd.i18n`
 *   —— 产品的翻译器是**惰性取**的（`defaultTranslate()` 查 `window.rmd.i18n`），
 *   想验"用户看到的那句话"就得把字典也铺上。⛔ 别改成给 `call()` 传第二个参数：
 *   `call()` 没有那个参数，那是**测试专用**的旁路，验不到产品路径。
 */
function 假装Tauri(形状, 带字典) {
  const 原 = global.window;
  global.window = { __TAURI__: 形状 };
  if (带字典) global.window.rmd = { i18n: I18N };
  return function () {
    if (原 === undefined) delete global.window;
    else global.window = 原;
  };
}

test('`resolveInvoke`：`core.invoke` 与 `invoke` 两种形状都认', function () {
  const a = function () {};
  const b = function () {};
  let 还原 = 假装Tauri({ core: { invoke: a } });
  try { assert.strictEqual(T.resolveInvoke(), a, '`__TAURI__.core.invoke` 应被认下'); } finally { 还原(); }
  还原 = 假装Tauri({ invoke: b });
  try { assert.strictEqual(T.resolveInvoke(), b, '`__TAURI__.invoke` 应被认下'); } finally { 还原(); }
});

test('`resolveInvoke`：两种形状都没有时报**一句人话**，⛔ 不是 `undefined is not a function`', function () {
  const 还原 = 假装Tauri({});
  try {
    assert.throws(function () { T.resolveInvoke(); }, /withGlobalTauri/);
  } finally { 还原(); }
});

test('⭐⭐ `call`：把后端 reject 归一成 `{kind, wording}`（`⌘E` 那条路的完整形状）', async function () {
  // ⭐ 这一条钉的是**用户看到那句话之前的最后一跳**：
  //    后端 `Denied::NoDocument` → `{"kind":"no_document"}` → 这里 → `wording`。
  // ⚠️ **带字典**：产品路径不传翻译器，靠 `defaultTranslate()` 惰性取 `window.rmd.i18n`
  //    ⇒ 不带字典的话下面比的就只是键，验不到"那句话"（`design/0025`）。
  const 还原 = 假装Tauri({
    core: {
      invoke: async function (cmd, args) {
        if (cmd === 'open_in_external_editor') throw { kind: 'no_document' };
        return { cmd: cmd, args: args };
      },
    },
  }, true);
  try {
    const ok = await T.call('get_session', { generation: 1 });
    assert.deepStrictEqual(ok, { cmd: 'get_session', args: { generation: 1 } }, '参数要原样透传（Tauri 2 按后端参数名取值）');

    await assert.rejects(
      function () { return T.call('open_in_external_editor'); },
      function (e) {
        assert.strictEqual(e.kind, 'no_document', '`kind` 要留下来');
        assert.strictEqual(e.wording, 中文(T.KIND_KEY.no_document), '⭐ 文案要走字典，⛔ 不是 message、⛔ 也不是键');
        assert.strictEqual(e.wording, '没有打开文档');
        assert.notStrictEqual(e.wording, 中文(T.OTHER_KEY), '⛔ 又掉进兜底了 —— `docs/bugs/0005` 就是这一格');
        return true;
      }
    );
  } finally { 还原(); }
});

test('`call`：没有参数时也发一个 `{}`（Tauri 2 不接受 `undefined`）', async function () {
  const 收到 = [];
  const 还原 = 假装Tauri({
    core: { invoke: async function (cmd, args) { 收到.push(args); return null; } },
  });
  try {
    await T.call('report_status');
    assert.deepStrictEqual(收到, [{}]);
  } finally { 还原(); }
});

test('`listen`：拿不到 `__TAURI__.event` 时报一句人话（⛔ 不静默）', async function () {
  const 还原 = 假装Tauri({});
  try {
    await assert.rejects(function () { return T.listen('rmd://menu', function () {}); }, /withGlobalTauri|ACL/);
  } finally { 还原(); }
});

// ═════════════════════════════════════════════════════════════════════════
// ⑤ `⌘E` 的**入口**必须先看本地真值（`docs/bugs/0005` 的另一半）
//
// ⚠️ 上一节修的是"后端拒了之后**怎么说**"，这一节修的是"**为什么要让后端拒**"。
//    `⌘E` 的入口曾经是**唯一**不先看 `S.state.currentDoc` 的：
//    `enterEdit()`（`main.js:911`）与 `saveNow()` 都先查，就它把"没有文档"
//    整件事推给后端 ⇒ 用户拿到的是后端那句拒绝。
//    ⭐ 后端拒得**对**（`NoDocument` 就是为这条路径加的），⛔ 但那不是"该有的说法"：
//    本地就知道的事，直接说"你还没打开文档"比"发一条注定被拒的 IPC 再解释"短。
// ═════════════════════════════════════════════════════════════════════════

const MAIN_JS = path.join(仓库根, 'src', 'main.js');

/** 抠出某个函数的函数体（花括号配平）。⚠️ 先剥注释，⛔ 免得被注释里的写法骗过。 */
function 抠函数体(代码, 签名) {
  const code = 剥注释(代码);
  const i = code.indexOf(签名);
  assert.ok(i >= 0, '⛔ 找不到 `' + 签名 + '` —— 闸门失效了，别放宽它');
  const start = code.indexOf('{', i);
  let depth = 0;
  let j = start;
  while (j < code.length) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') { depth--; if (depth === 0) break; }
    j++;
  }
  return code.slice(start, j + 1);
}

/**
 * ⭐ 判据：这一段里有一条「**没有当前文档就早退**」。
 * ⛔ 不放宽成"提到了 `currentDoc`"——注释里提一句、或者拿它去拼一句提示语，
 * 都能让"提到了"变绿，而**该挡的那条 IPC 照样发出去**。
 */
function 有早退闸(段) {
  return /if\s*\(\s*!\s*S\.state\.currentDoc\s*\)\s*\{[\s\S]*?\breturn\b/.test(段);
}

test('⭐⭐ 接线（源码级）：`⌘E` 入口在没有当前文档时必须早退（`docs/bugs/0005`）', function () {
  // ⚠️ `src/main.js` 是根脚本，不进 `require` ⇒ 只能按源码级闸门写
  //    （同族先例：`tests/js/editor.test.js` 末尾那条 `markEdited` 接线）。
  const 段 = 抠函数体(fs.readFileSync(MAIN_JS, 'utf8'), 'function openExternalEditor(');
  assert.ok(
    有早退闸(段),
    '⛔ `openExternalEditor` 里没有「`!S.state.currentDoc` ⇒ return」这道闸 —— ' +
      '空会话下按 `⌘E` 会发一条注定被拒的 IPC，用户拿到的是后端的拒绝而不是"你还没打开文档"'
  );
  // ⚠️ 反面判据：闸必须在**问"有没有未保存修改"之前**吗？不必——
  //    但**必须在** `openExternalEditorNow()` 之前（否则那条 IPC 已经在飞了）。
  assert.ok(
    段.indexOf('currentDoc') < 段.indexOf('openExternalEditorNow'),
    '⛔ 早退闸排在 `openExternalEditorNow()` 后面 —— 那是"发完 IPC 再判"，等于没这道闸'
  );
});

test('⭐ 诱饵：把早退闸摘掉，上面那条判据必须**变红**', function () {
  // ⚠️ 这条证明的是判据**真的在看那道闸**，⛔ 不是恒真的正则。
  const 段 = 抠函数体(fs.readFileSync(MAIN_JS, 'utf8'), 'function openExternalEditor(');
  const 摘掉 = 段.replace(/if\s*\(\s*!\s*S\.state\.currentDoc\s*\)\s*\{[\s\S]*?\}/, '');
  assert.notStrictEqual(摘掉, 段, '⛔ 诱饵没生效：闸没被摘掉，这条自证是假的');
  assert.strictEqual(有早退闸(摘掉), false, '⛔ 闸摘了判据还绿 —— 判据是空转的');
});
