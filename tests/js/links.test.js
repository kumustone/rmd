// `design/0026` §7.2 的那一组（`tests/js/links.test.js`）：文档内链接的**纯逻辑**
// ＋ **两条源码级闸门**（委托注册次序、只读 `getAttribute('href')`）。
//
// ⚠️ 这些断言的错法**全是静默的**（`docs/bugs/0001` 就是这一族第一次发作）：
//    `plan` 漏一格 ⇒ 那个 `kind` 点下去**什么都不发生**（`INV-LINK-08`）；
//    `unauthorized` 与 `missing` 合成一句 ⇒ 界面开始**透露授权外存不存在**（§6「最怕的四件事」）；
//    委托抢在图片那一层之前注册 ⇒ `<a><img></a>` 一次点击**两个动作**；
//    读 `a.href` 而不是 `getAttribute('href')` ⇒ **相对链接全部变成绝对 URL**；
//    锚点滚动绕过 `hostSetTop` ⇒ 编辑态下被判成"用户接管"，预览栏反向拉走源码栏。
// ⇒ 逐条钉边界，⛔ 不靠"看起来对"。
//
// ⚠️ 本文件**不起浏览器、不点任何东西**：需要真 DOM 的那半（谁先拿到事件、
//    闸门回调有没有被调到）在离屏探针 `make probe-link-nav`（`tools/wkwebview-probe/`）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../../src/services/links.js');
const I = require('../../src/services/i18n.js');

const ROOT = path.join(__dirname, '..', '..');

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 剥注释（行 ＋ 块）。⚠️ 与 `dirsession.test.js` 那份同一条说明。 */
function 去注释(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** ⭐ **裸判据**：按花括号配平抠出某个 `function 名(` 的函数体（剥注释后调用）。 */
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
  return null; // 配不平 ⇒ 当作没抠到（⛔ 不假装成功）
}

/** 字典里一个模板的占位符集合（`{href}` → `href`）。 */
function 占位(tpl) {
  const out = [];
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(tpl))) out.push(m[1]);
  return out.sort();
}

/** 每种 `kind` 的一份**像样的**回包（字段名与 `commands/link.rs::LinkOutcome` 一致）。 */
const SAMPLE = {
  empty: { kind: 'empty' },
  anchor: { kind: 'anchor', fragment: 'sec-1' },
  document: { kind: 'document', path: '/a/b.md', fragment: 'sec-1' },
  reveal: { kind: 'reveal' },
  external: { kind: 'external' },
  reveal_failed: { kind: 'reveal_failed', message: 'boom' },
  external_failed: { kind: 'external_failed', message: 'boom' },
  unauthorized: { kind: 'unauthorized', href: 'other.md' },
  missing: { kind: 'missing', href: 'other.md' },
  unsupported: { kind: 'unsupported', message: 'mailto' },
  local_query: { kind: 'local_query', href: 'other.md?q=1' },
  no_document: { kind: 'no_document' },
  stale: { kind: 'stale' },
  failed: { kind: 'failed', message: 'boom' },
};

const ACTIONS = ['status', 'anchor', 'open', 'ask-auth'];

// ══ `href` 归一（#1–#3）═════════════════════════════════════════════

test('#1 normalizeHref：只 trim，中间一个字符都不动', function () {
  assert.strictEqual(L.normalizeHref('  other.md  '), 'other.md');
  assert.strictEqual(L.normalizeHref('\n#sec-1\t'), '#sec-1');
  assert.strictEqual(L.normalizeHref('  a b/c d.md#e f  '), 'a b/c d.md#e f');
});

test('#2 normalizeHref：非字符串一律空串（⛔ 不 String() 出 "undefined"）', function () {
  assert.strictEqual(L.normalizeHref(undefined), '');
  assert.strictEqual(L.normalizeHref(null), '');
  assert.strictEqual(L.normalizeHref(42), '');
  assert.strictEqual(L.normalizeHref({}), '');
  assert.strictEqual(L.normalizeHref(['a.md']), '');
});

test('#3 normalizeHref：⛔ 不解码、⛔ 不改写（那是后端那一份的事）', function () {
  // ⚠️ 前端再解一次就是**二次解码**：`a%2520b` 会变成 `a b`，那是**另一个文件**。
  assert.strictEqual(L.normalizeHref('a%2520b.md'), 'a%2520b.md');
  assert.strictEqual(L.normalizeHref('../x.md'), '../x.md');
  assert.strictEqual(L.normalizeHref('file:///tmp/a.md'), 'file:///tmp/a.md');
  assert.strictEqual(L.normalizeHref('javascript:alert(1)'), 'javascript:alert(1)');
});

// ══ 锚点片段（#4–#6）════════════════════════════════════════════════

test('#4 decodeFragment：解一次，且认不认 `#` 都行', function () {
  assert.strictEqual(L.decodeFragment('#a%20b'), 'a b');
  assert.strictEqual(L.decodeFragment('a%20b'), 'a b');
  assert.strictEqual(L.decodeFragment('#%E4%B8%AD%E6%96%87'), '中文');
  assert.strictEqual(L.decodeFragment('plain'), 'plain');
  assert.strictEqual(L.decodeFragment('#'), '');
});

test('#5 decodeFragment：非法序列**原样保留**（⛔ 不让它抛）', function () {
  // ⚠️ 与后端 `percent_decode` 同一口径：标题里真有一个 `%` 比"谁写错了编码"更常见。
  assert.strictEqual(L.decodeFragment('#100%zz'), '100%zz');
  assert.strictEqual(L.decodeFragment('%'), '%');
  assert.strictEqual(L.decodeFragment('%E4%B8'), '%E4%B8'); // 半个 UTF-8 序列
});

test('#6 decodeFragment：非字符串 ⇒ 空串', function () {
  assert.strictEqual(L.decodeFragment(undefined), '');
  assert.strictEqual(L.decodeFragment(null), '');
  assert.strictEqual(L.decodeFragment(7), '');
});

// ══ 锚点查找（#7–#8）════════════════════════════════════════════════

test('#7 anchorFor：只用 `getElementById`（含 `:`/`.` 的 ID 不许抛）', function () {
  const seen = [];
  const el = { id: 'sec:1.2' };
  const doc = {
    // ⚠️ 刻意**不提供** `querySelector`：一旦实现改成 `'#' + fragment`，
    //    这条会以 TypeError 红掉，而不是在真机上"某个标题点了没反应"。
    getElementById: function (id) { seen.push(id); return id === 'sec:1.2' ? el : null; },
  };
  assert.strictEqual(L.anchorFor('sec:1.2', doc), el);
  assert.deepStrictEqual(seen, ['sec:1.2']);
});

test('#8 anchorFor：空片段 / 没有 / 没有容器 ⇒ `null`（调用方必须说话）', function () {
  const doc = { getElementById: function () { return null; } };
  assert.strictEqual(L.anchorFor('', doc), null);
  assert.strictEqual(L.anchorFor(undefined, doc), null);
  assert.strictEqual(L.anchorFor(null, doc), null);
  assert.strictEqual(L.anchorFor('nope', doc), null);
  assert.strictEqual(L.anchorFor('x', null), null);
  assert.strictEqual(L.anchorFor('x', {}), null); // 没有 getElementById
});

// ══ 结果 → 动作（#9–#15）════════════════════════════════════════════

test('#9 plan：每一种 `kind` 都有一格，且形状合法（`INV-LINK-08`）', function () {
  assert.deepStrictEqual(L.KINDS.slice().sort(), Object.keys(SAMPLE).sort(),
    'KINDS 与 SAMPLE 不同步：加一个 kind 时两处都要改');
  L.KINDS.forEach(function (kind) {
    const p = L.plan(SAMPLE[kind]);
    assert.ok(p && typeof p === 'object', kind + ' 没给出动作');
    assert.ok(ACTIONS.indexOf(p.action) >= 0, kind + ' 的动作不在那张表里：' + p.action);
    if (p.action === 'status') {
      assert.strictEqual(typeof p.key, 'string', kind + ' 的 status 没有 key');
      assert.ok(p.key.length > 0, kind + ' 的 status key 是空串');
    }
    if (p.action === 'anchor') assert.strictEqual(typeof p.fragment, 'string');
    if (p.action === 'open') {
      assert.strictEqual(typeof p.path, 'string');
      assert.strictEqual(typeof p.fragment, 'string');
    }
    if (p.action === 'ask-auth') assert.strictEqual(typeof p.key, 'string');
  });
});

test('#10 plan：每一个 `link.*` 键两本字典都有，占位符与 vars 对得上', function () {
  L.KINDS.forEach(function (kind) {
    const p = L.plan(SAMPLE[kind]);
    if (!p.key) return;
    ['zh', 'en'].forEach(function (lang) {
      assert.ok(I.has(p.key, lang), kind + ' 用的 `' + p.key + '` 在 ' + lang + ' 字典里缺');
    });
    const vars = Object.keys(p.vars || {}).sort();
    // ⚠️ 只比"键集合"：文案里多写一个占位符 ⇒ `t()` 会把它原样留在屏幕上（`{}` 形态），
    //    而**没有任何报错**——这正是 `i18n.test.js` 的 `missingVars` 盯的那一类。
    assert.deepStrictEqual(占位(I.DICT.zh[p.key]), vars, p.key + ' 的 zh 占位符与 vars 不一致');
    assert.deepStrictEqual(占位(I.DICT.en[p.key]), vars, p.key + ' 的 en 占位符与 vars 不一致');
  });
});

test('#11 plan：`unauthorized` 与 `missing` **必须是两件事**', function () {
  // ⚠️§6「最怕的四件事」第三条：把两者合成一句 = 界面开始**透露授权外存不存在**。
  const a = L.plan({ kind: 'unauthorized', href: 'x.md' });
  const b = L.plan({ kind: 'missing', href: 'x.md' });
  assert.notStrictEqual(a.action, b.action);
  assert.notStrictEqual(a.key, b.key);
  assert.strictEqual(a.action, 'ask-auth'); // 引导用户显式授权，⛔ 不自动授权
  assert.strictEqual(b.action, 'status');
  assert.deepStrictEqual(a.vars, { href: 'x.md' });
  assert.deepStrictEqual(b.vars, { href: 'x.md' });
});

test('#12 plan：`empty` 与 `anchor` 分离（⛔ 空 href 当成"回到顶部"）', function () {
  const e = L.plan({ kind: 'empty' });
  const a = L.plan({ kind: 'anchor', fragment: 'sec' });
  assert.strictEqual(e.action, 'status');
  assert.strictEqual(e.isError, true);
  assert.strictEqual(a.action, 'anchor');
  assert.strictEqual(a.fragment, 'sec');
});

test('#13 plan：`document` 的 path 原样带过（前端⛔ 不拼路径、⛔ 不归一）', function () {
  // ⚠️ `INV-LINK-03`：拼路径/判授权只在后端做得到。前端加工一次就是**第二条真值**。
  ['../../a b/c d.md', '/abs/x.md', 'C:\\weird\\x.md', 'x/./y/../z.md'].forEach(function (pth) {
    const p = L.plan({ kind: 'document', path: pth, fragment: 'f' });
    assert.strictEqual(p.action, 'open');
    assert.strictEqual(p.path, pth);
    assert.strictEqual(p.fragment, 'f');
  });
  // 字段缺失 ⇒ 空串（调用方 `openLinkedDocument` 会为它说一句，⛔ 不是静默）
  const q = L.plan({ kind: 'document' });
  assert.strictEqual(q.path, '');
  assert.strictEqual(q.fragment, '');
});

test('#14 plan：`failed` 族把后端的 message 原样带进文案，`unsupported` 带 scheme', function () {
  assert.deepStrictEqual(L.plan({ kind: 'failed', message: 'EACCES' }).vars, { message: 'EACCES' });
  assert.deepStrictEqual(L.plan({ kind: 'reveal_failed', message: 'nope' }).vars, { message: 'nope' });
  assert.deepStrictEqual(L.plan({ kind: 'external_failed', message: 'nope' }).vars, { message: 'nope' });
  assert.deepStrictEqual(L.plan({ kind: 'unsupported', message: 'javascript' }).vars, { scheme: 'javascript' });
  // 缺 message 时⛔ 不印 `undefined`
  assert.deepStrictEqual(L.plan({ kind: 'failed' }).vars, { message: '' });
  assert.deepStrictEqual(L.plan({ kind: 'unsupported' }).vars, { scheme: '?' });
});

test('#15 plan：未知 / 空的回包**仍然说一句话**（⛔ 点了没反应）', function () {
  // ⚠️ 后端加了新 kind 而这张表没跟上 ⇒ 这是**唯一**能让用户看到"出了事"的地方。
  [{ kind: 'brand_new' }, { kind: '' }, {}, null, undefined, 'nope', 42].forEach(function (out) {
    const p = L.plan(out);
    assert.strictEqual(p.action, 'status');
    assert.strictEqual(p.key, 'link.failed');
    assert.strictEqual(p.isError, true);
    assert.strictEqual(typeof p.vars.message, 'string');
  });
  // 原始 kind 带进 message，便于在状态条上认出来（⛔ 不吞掉线索）
  assert.strictEqual(L.plan({ kind: 'brand_new' }).vars.message, 'brand_new');
});

// ══ 存活判据（#16）══════════════════════════════════════════════════

test('#16 isAlive：按 `doc_seq` **严格相等**（⛔ 宽松比较、⛔ 认时间）', function () {
  assert.strictEqual(L.isAlive(3, 3), true);
  assert.strictEqual(L.isAlive(undefined, undefined), true); // 还没有文档两端都是 undefined
  assert.strictEqual(L.isAlive(3, 4), false);
  assert.strictEqual(L.isAlive('3', 3), false); // ⚠️ 类型不同就是不同：`===`
  assert.strictEqual(L.isAlive(null, 0), false);
  assert.strictEqual(L.isAlive(0, 0), true);
});

// ══ 源码级闸门：`links.js` 自己（#17–#18）════════════════════════════

test('#17 links.js：`KINDS` 与 `plan` 的 case 清单一一对应', function () {
  // ⚠️ 加一个 case 忘了加进 KINDS ⇒ #9 的全覆盖**恰好也发现不了**（它按 KINDS 迭代）。
  //    这条从**源码**取 case 清单，把那个缺口堵上。
  const code = 去注释(readSrc('src/services/links.js'));
  const body = 身体(code, 'plan');
  assert.ok(body, '抠不到 `plan` 的函数体');
  const cases = [];
  const re = /case\s+'([^']+)'\s*:/g;
  let m;
  while ((m = re.exec(body))) cases.push(m[1]);
  assert.ok(cases.length >= 10, 'case 数不对，正则写错了？');
  assert.deepStrictEqual(cases.sort(), L.KINDS.slice().sort());
});

test('#18 links.js：不碰授权、不碰路径解析、不碰 IPC（`INV-LINK-03`）', function () {
  // ⚠️ 这个文件**只能**做前端真做得到的事。出现下面任何一个词，说明有人在它里面
  //    起了第二条真值（或者偷偷加了一条读取路径）——而它在前端**永远不会被拦**。
  const code = 去注释(readSrc('src/services/links.js'));
  ['check_readable', 'open_document', 'canonicaliz', 'invoke(', 'window.rmd.session',
    'fs.', 'path.join', 'querySelector'].forEach(function (bad) {
    assert.strictEqual(code.indexOf(bad), -1, 'links.js 里出现了 `' + bad + '`：' + '它不该懂这件事');
  });
});

// ══ 源码级闸门：`main.js` 的接线（#19–#24）══════════════════════════

test('#19 委托注册次序：链接**必须在图片之后**（一次点击只发生一个动作）', function () {
  // ⚠️⚠️ `<a><img></a>` 上两层委托都会收到同一次 click（`stopPropagation` 拦不住
  //      **同一元素上的**另一个监听器）。图片那层先 `preventDefault`，链接这层读标记退出。
  //      反过来注册 ⇒ **缩放开一次、文档再开一次**，而两个动作各自都"成功"。
  const code = 去注释(readSrc('src/main.js'));
  const img = code.indexOf('ImageViewer.installDelegation(');
  const re = /installLinkDelegation\(\s*\$\('doc'\)\s*\)/g;
  const m = re.exec(code);
  assert.ok(img >= 0, '找不到 `ImageViewer.installDelegation(`——前一条委托被改名/删了？');
  assert.ok(m, 'boot 里没有 `installLinkDelegation($(\'doc\'))`');
  assert.ok(img < m.index, '链接委托排在了图片委托**之前**：一次点击会走两个动作');
  assert.strictEqual(re.exec(code), null, '`installLinkDelegation($(\'doc\'))` 被调了不止一次');
});

test('#20 只读 `getAttribute(\'href\')`，⛔ 不读 `a.href`（相对链接会被解析成绝对 URL）', function () {
  const code = 去注释(readSrc('src/main.js'));
  const body = 身体(code, 'installLinkDelegation');
  assert.ok(body, '抠不到 `installLinkDelegation` 的函数体');
  // ⭐ `bugs/0058` 起三条激活路径（左键 / 中键 / 键盘）共用 `打开链接(a)`，
  //    取 `href` 只剩**一处** ⇒ 数量从 2 收到 1（⛔ 不是放宽：多了反而说明又开了第二条路）。
  assert.strictEqual((body.match(/getAttribute\(\s*'href'\s*\)/g) || []).length, 1,
    '取 `href` 只能有**一处**（左键/中键/键盘都走 `打开链接(a)`）');
  // `.href` 是**解析后**的绝对 URL；这里出现一次就够把相对链接全带偏。
  assert.strictEqual(/\.\s*href\b/.test(body), false, '出现 `.href`（属性访问）——必须用 getAttribute');
});

test('#20b 三条激活路径**都**走同一个 `打开链接(a)`（⛔ 各写一份 followLink）', function () {
  // ⚠️ `bugs/0058` 的真教训是"每种手势各判一次、其中一种判错" ⇒ 这里钉住**唯一出口**：
  //    `followLink(` 在委托里只许出现**一次**，三个监听器都调 `打开链接(`。
  const code = 去注释(readSrc('src/main.js'));
  const body = 身体(code, 'installLinkDelegation');
  assert.ok(body, '抠不到 `installLinkDelegation` 的函数体');
  assert.strictEqual((body.match(/followLink\(/g) || []).length, 1,
    '`followLink(` 在委托里出现了不止一次——手势分支各写了一份');
  // ⭐ `bugs/0058` 第二版再加一条来源：后端 `rmd://link-activation`（WKWebView 不把
  //    `⌘`-点击派给页面）也调它 ⇒ 3 条 DOM 路径 ＋ 1 条后端路径 ＋ 它自己的定义。
  assert.strictEqual((body.match(/打开链接\(/g) || []).length, 3 + 1 + 1,
    '三条 DOM 路径与一条后端路径应当各调一次 `打开链接(`，外加它自己的定义');
  // 中键那两条路都要有：现代 WebKit 只发 `auxclick`，老 WebKit 只发 `click`。
  assert.ok(/addEventListener\('auxclick',\s*onAuxClick\)/.test(body), '没有监听 `auxclick`（现代 WebKit 中键走这条）');
  assert.ok(/e\.button === MIDDLE/.test(body), '`click` 那条路没有认中键');
});

test('#21 `onClick` / `onAuxClick` / `onKeydown`：`defaultPrevented` 是第一句（在 preventDefault 之前）', function () {
  const code = 去注释(readSrc('src/main.js'));
  ['onClick', 'onAuxClick', 'onKeydown'].forEach(function (名) {
    const body = 身体(code, 名);
    assert.ok(body, '抠不到 `' + 名 + '` 的函数体');
    const seen = body.indexOf('defaultPrevented');
    const prevent = body.indexOf('preventDefault()');
    assert.ok(seen >= 0, 名 + ' 没读 `defaultPrevented`');
    assert.ok(prevent >= 0, 名 + ' 没调 `preventDefault()`（`INV-LINK-02`）');
    assert.ok(seen < prevent, 名 + ' 先 `preventDefault` 才读标记——顺序反了等于没读');
    // ⚠️ 还要排在"找链接"之前：先判"这一击已经被别人处理"，再谈这是不是一条链接。
    const find = body.indexOf('linkOf(');
    assert.ok(find >= 0 && seen < find, 名 + ' 先找链接才读 `defaultPrevented`');
  });
});

test('#22 `followLink`：带回 `doc_seq`，回包后**先判存活再做动作**（`INV-LINK-11`）', function () {
  const code = 去注释(readSrc('src/main.js'));
  const body = 身体(code, 'followLink');
  assert.ok(body, '抠不到 `followLink` 的函数体');
  assert.ok(/S\s*\.\s*openLink\(\s*raw\s*,\s*seq\s*\)/.test(body),
    '`openLink` 没有原样带回点击那一刻的 seq');
  const alive = body.indexOf('isAlive');
  const apply = body.indexOf('applyLinkPlan');
  assert.ok(alive >= 0, '回包之后没有判存活');
  assert.ok(apply >= 0, '没有把结果落到界面上');
  assert.ok(alive < apply, '先落地再判存活——`await` 期间换过文档时会把新文档顶掉');
});

test('#23 `scrollToFragment`：只能经 `hostSetTop`（⛔ scrollTop= / scrollIntoView）', function () {
  // ⚠️⚠️ `hostSetTop()` 是全项目唯一一处"把阅读位置写回去"（`design/0012` §2.6-5）。
  //      绕过去 ⇒ 编辑态下这次移动被判成"用户接管"，预览栏立刻反向驱动源码栏
  //      （`docs/bugs/0006` 的形态）。锚点导航正是最容易顺手写 `scrollIntoView` 的地方。
  const code = 去注释(readSrc('src/main.js'));
  const body = 身体(code, 'scrollToFragment');
  assert.ok(body, '抠不到 `scrollToFragment` 的函数体');
  assert.ok(body.indexOf('hostSetTop(') >= 0, '没有经 `hostSetTop`');
  assert.strictEqual(body.indexOf('scrollIntoView'), -1, '用了 `scrollIntoView`');
  assert.strictEqual(/scrollTop\s*=/.test(body), false, '直接写了 `scrollTop =`');
  assert.ok(body.indexOf('anchorFor(') >= 0, '没有用 `links.js` 的锚点查找（第二条实现？）');
});

test('#24 找到锚点之前先说话：缺失走 `link.anchor-missing`（⛔ 猜最近标题）', function () {
  const code = 去注释(readSrc('src/main.js'));
  const body = 身体(code, 'scrollToFragment');
  assert.ok(body.indexOf('link.anchor-missing') >= 0, '锚点缺失时没有任何提示');
  assert.strictEqual(/closest\(\s*'h[1-6]'/.test(code), false,
    'main.js 里出现了"往上找最近标题"——那是猜，`INV-LINK-08` 要的是明确提示');
});

// ══ 源码级闸门：键与页面（#25–#26）══════════════════════════════════

test('#25 main.js 里引用的每一个 `link.*` 键，两本字典都有', function () {
  // ⚠️ 这条管的是 `plan` **走不到**的那几个键（`link.anchor-missing` / 决策条上的两个
  //    按钮 / …）：它们直接写在 `main.js` 里，缺了就是屏幕上出现一个**原始键名**。
  const code = 去注释(readSrc('src/main.js'));
  const keys = [];
  const re = /'(link\.[a-z-]+)'/g;
  let m;
  while ((m = re.exec(code))) if (keys.indexOf(m[1]) < 0) keys.push(m[1]);
  assert.ok(keys.length >= 4, '一个 `link.*` 键都没扫到，正则写错了？');
  keys.forEach(function (k) {
    ['zh', 'en'].forEach(function (lang) {
      assert.ok(I.has(k, lang), '`' + k + '` 在 ' + lang + ' 字典里缺（屏幕上会是原始键名）');
    });
  });
});

test('#26 index.html：`services/links.js` 在 `main.js` **之前**且只出现一次', function () {
  // ⚠️ 经典脚本按顺序执行、`main.js` 在**加载期**取 `window.rmd.links` ⇒ 排后面时
  //    那个常量是 `undefined`，只有第一次点链接才炸（`0009` 的 `search.js` 同族）。
  //    `keymap.test.js` 的「脚本加载顺序」也从定义处推了一遍，这里是这条依赖的直述。
  const html = readSrc('src/index.html');
  const order = [];
  const re = /<script\s+src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) order.push(m[1]);
  const at = function (rel) { return order.indexOf(rel); };
  assert.ok(at('services/links.js') >= 0, 'index.html 没加载 `services/links.js`');
  assert.strictEqual(order.filter(function (p) { return p === 'services/links.js'; }).length, 1,
    '`services/links.js` 被加载了不止一次');
  assert.ok(at('services/links.js') < at('main.js'), '`links.js` 排在 `main.js` 之后');
  assert.ok(at('services/links.js') < at('services/session.js'),
    '`links.js` 与其余"无依赖的纯逻辑"同群，排在 `session.js` 之后没有理由');
});

test('#27 手势判据**转调** `K.isOpenGesture`（⛔ 在调用侧写第二份）', function () {
  // ⚠️ 与 `components/ImageViewer.js` 同一条纪律（`design/0018` §2.3 ④ 的先例）：
  //    "这个事件是什么手势"只有一个实现（`services/keymap.js`）。
  //    ⛔ 在 `owns()` 里再写一遍 `e.metaKey || …` 会让两份判据慢慢漂开，
  //    而 `keymap.test.js` 那条「修饰键标识符只允许出现在 keymap.js」是**同一件事**的
  //    结构闸门——这里把它钉在"这个函数"上，红了能直接指到行。
  //
  // ⭐ `bugs/0058`：这里原先钉的是 `!K.hasModifier(e)`，于是**带 `⌘` 的点击被整类放过**
  //    ⇒「⌘+点击链接什么也不发生」。判据不变形（仍是转调一个函数），换的是**那个函数**：
  //    `hasModifier` 问"带不带修饰键"，`isOpenGesture` 问"算不算打开的意思"，两个问题。
  const code = 去注释(readSrc('src/main.js'));
  const body = 身体(code, 'owns');
  assert.ok(body, '抠不到 `owns` 的函数体');
  assert.ok(/K\s*\.\s*isOpenGesture\(\s*e\s*\)/.test(body),
    '`owns` 没有转调 `K.isOpenGesture(e)`');
  // ⛔ 负判据：退回 `hasModifier` 就是把 `bugs/0058` 装回去（带 ⌘ 的点击又被放过）。
  assert.strictEqual(/hasModifier/.test(body), false,
    '`owns` 又用回 `K.hasModifier` —— 那是"带不带修饰键"，不是"算不算打开"（`bugs/0058`）');
  assert.strictEqual(/(metaKey|ctrlKey|altKey)/.test(body), false,
    '`owns` 自己判了修饰键——那是第二份判据');
});

test('#28 后端「想开新窗口 / 想导航走」那条通道：接住了，且只认 DOM 里指针下的链接', function () {
  // ⚠️⚠️ 用户实测（2026-11-02，`bugs/0058` 第二版）：`owns()` 改成"`⌘` 也算打开"
  //    **之后 ⌘-点击仍然毫无反应**。根因不在判据，而在**事件根本没到页面**：
  //    macOS 的 WKWebView 把 `⌘`-点击 / 中键当成"用新窗口打开这条链接"，
  //    由 UI 进程直接处理 ⇒ 页面里的 `click` 委托一次都不跑。
  //    ⇒ 手势只能在 `on_new_window` / `on_navigation` 露出，由 Rust 交回前端。
  //
  // ⚠️ 下面几条守的都是**静默失效**：漏订阅 = 后端发了没人听；用事件里的 URL =
  //    相对链接在那一层已是 `tauri://localhost/…`，倒推回文档目录会**指错文件**；
  //    没有去重 = 一次 ⌘-点击开两次（第二跳多半回 `stale`，状态条上多一行废话）。
  const code = 去注释(readSrc('src/main.js'));

  // ① 通道订阅了。
  assert.ok(/T\s*\.\s*listen\(\s*'rmd:\/\/link-activation'/.test(code),
    '没有订阅 `rmd://link-activation`（后端发了没人听 ⇒ 与缺陷本身同形：静默）');

  // ② 落点是**指针下的那条链接**，⛔ 不是事件载荷里的 URL。
  const body = 身体(code, 'activateAtPointer');
  assert.ok(body, '抠不到 `activateAtPointer` 的函数体');
  assert.ok(body.indexOf('指针下的链接') >= 0, '没有用指针下那条 `#doc a[href]`');
  assert.strictEqual(/payload|url/i.test(body), false,
    '用了事件里的 URL——那一层拿不到文档目录，倒推出来的路径会指错文件');

  // ③ 去重窗口：同一击可能**既**走 DOM **又**走后端。
  assert.ok(/最近打开\s*\.\s*at/.test(body), '没有去重窗口（一次点击会开两次）');

  // ④ 委托把这条入口交出来（`installLinkDelegation` 的返回值必须被接住）。
  assert.ok(/const\s+链接委托\s*=\s*installLinkDelegation\(\s*\$\('doc'\)\s*\)/.test(code),
    '委托的返回值没有被接住 ⇒ `activateAtPointer` 无处可取');
  assert.ok(/链接委托\s*\.\s*activateAtPointer\(\)/.test(code),
    '订阅回调没有调 `activateAtPointer()`');

  // ⑤ hover 记账挂着、且 `passive`（只记事，⛔ 不动默认行为）。
  assert.ok(/addEventListener\('mousemove',\s*onHover,\s*\{\s*passive:\s*true\s*\}\)/.test(code),
    '没有记下指针停在哪条链接上');

  // ⑥ Rust 侧：两条回调都转发（`on_new_window` 是 ⌘-点击真正的露面处，
  //    `on_navigation` 是它万一走另一条路时的兜底）。
  const rust = 去注释(readSrc('src-tauri/src/gui/mod.rs'));
  assert.ok(rust.indexOf("rmd://link-activation") >= 0, 'Rust 侧没有发这条事件');
  assert.strictEqual((rust.match(/bridge_link_activation\(/g) || []).length, 3,
    '`bridge_link_activation(` 应当出现 3 次：1 次定义 ＋ `on_navigation` ＋ `on_new_window`');
  assert.ok(/on_new_window\(\{/.test(rust), '`on_new_window` 没有接上转发的那个闭包');
});
