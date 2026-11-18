// i18n 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：语言标签归一（zh-CN / en-US / 未知值）、回落链与缺键记账、
// 占位符替换与缺参、`<html lang>` 的运行时改写、`data-i18n*` 的四类重贴、
// 中英两本字典的键集 / 占位符一致性，以及不做 HTML 注入口那条边界。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'i18n.js'), 'utf8');

/**
 * 每次新建一个 i18n 实例：语言与缺键记录都是模块内状态，⛔ 不能跨用例复用。
 * @param {object} [extra] 注入到假 window 上的字段（如 `__rmdLang` / `document`）
 */
function loadI18n(extra) {
  const win = Object.assign({}, extra || {});
  new Function('window', SRC)(win);
  return { win: win, I: win.rmd.i18n };
}

function fresh() {
  return loadI18n().I;
}

function silence(fn) {
  const old = console.error;
  const logs = [];
  console.error = function () { logs.push([].slice.call(arguments).join(' ')); };
  try {
    return { value: fn(), logs: logs };
  } finally {
    console.error = old;
  }
}

/**
 * 假 document：按选择器给出节点，并记录 documentElement 的 lang。
 * @param {object} bySel 选择器 → 节点数组
 */
function makeDoc(bySel) {
  const langAttrs = [];
  const doc = {
    documentElement: {
      setAttribute: function (k, v) { if (k === 'lang') langAttrs.push(v); },
    },
    querySelectorAll: function (sel) { return bySel[sel] || []; },
  };
  return { doc: doc, langAttrs: langAttrs };
}

/**
 * 假节点：记录 textContent 与属性写。
 * @param {object} attrs 初始属性（含 `data-i18n*`）
 */
function makeNode(attrs) {
  const a = Object.assign({}, attrs || {});
  const node = {
    textContent: 'OLD',
    attrs: a,
    setAttrs: [],
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(a, k) ? a[k] : null; },
    setAttribute: function (k, v) { a[k] = v; node.setAttrs.push([k, v]); },
  };
  return node;
}

// ── normalizeLang：语言标签 ─────────────────────────────────────

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('zh 的所有常见形态都归一成 zh', () => {
  const I = fresh();
  for (const l of ['zh', 'zh-CN', 'zh-Hans-CN', 'ZH-cn', ' zh ', 'zh-TW']) {
    assert.strictEqual(I.normalizeLang(l), 'zh', String(l));
  }
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('en 的前缀形态归一成 en，⛔ 不是精确匹配 en 才行', () => {
  const I = fresh();
  for (const l of ['en', 'en-US', 'en-GB', 'EN-us', 'en-']) {
    assert.strictEqual(I.normalizeLang(l), 'en', String(l));
  }
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('未知语言 / 空值 / 非字符串一律回落出厂语言 zh', () => {
  const I = fresh();
  for (const l of [null, undefined, '', 'fr', 'ja-JP', 'english', 'en_US', 0, false]) {
    assert.strictEqual(I.normalizeLang(l), 'zh', String(l));
  }
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('normalizeLang 先 String 再判断：带 toString 的对象也能给 en', () => {
  const I = fresh();
  assert.strictEqual(I.normalizeLang({ toString: function () { return 'en-US'; } }), 'en');
  assert.strictEqual(I.normalizeLang({ toString: function () { return 'fr'; } }), 'zh');
});

// ── 初始语言：只认注入值 ────────────────────────────────────────

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('没有 __rmdLang 时出厂语言是 zh', () => {
  assert.strictEqual(fresh().lang(), 'zh');
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('注入 __rmdLang 决定初始语言，且同样走归一', () => {
  assert.strictEqual(loadI18n({ __rmdLang: 'en-US' }).I.lang(), 'en');
  assert.strictEqual(loadI18n({ __rmdLang: 'EN' }).I.lang(), 'en');
  assert.strictEqual(loadI18n({ __rmdLang: 'fr' }).I.lang(), 'zh');
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('⛔ 不读 navigator.language：只注入 navigator 不会改语言', () => {
  const { I } = loadI18n({ navigator: { language: 'en-US', languages: ['en-US'] } });
  assert.strictEqual(I.lang(), 'zh');
});

// ── t：取词与回落链 ─────────────────────────────────────────────

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('中文与英文各取自己的那本：同一键两种语言不同值', () => {
  const I = fresh();
  assert.strictEqual(I.t('sidebar.tab-files'), '文件');
  assert.strictEqual(I.t('settings.title'), '设置');
  assert.strictEqual(I.t('doc.empty-choose'), '从左侧选择一份文档');
  I.setLang('en');
  assert.strictEqual(I.t('sidebar.tab-files'), 'Files');
  assert.strictEqual(I.t('settings.title'), 'Settings');
  assert.strictEqual(I.t('doc.empty-choose'), 'Choose a document on the left');
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('t 永远返回字符串：空键给可辨认的 ASCII 标记，⛔ 不返回空串', () => {
  const I = fresh();
  assert.strictEqual(I.t(''), '(i18n: empty key)');
  assert.strictEqual(I.t(null), '(i18n: empty key)');
  assert.strictEqual(I.t(undefined), '(i18n: empty key)');
  assert.deepStrictEqual(I.missing(), ['']);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('两本都没有的键显示键本身，并只记一次', () => {
  const I = fresh();
  assert.strictEqual(I.t('no.such.key'), 'no.such.key');
  assert.strictEqual(I.t('no.such.key'), 'no.such.key');
  assert.deepStrictEqual(I.missing(), ['no.such.key']);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('当前语言缺、zh 有 ⇒ 回落中文并记账（去重）', () => {
  const { I } = loadI18n();
  delete I.DICT.en['sidebar.tab-files'];
  I.setLang('en');
  assert.strictEqual(I.t('sidebar.tab-files'), '文件');
  assert.strictEqual(I.t('sidebar.tab-files'), '文件');
  assert.deepStrictEqual(I.missing(), ['sidebar.tab-files']);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('en 有、zh 缺的键在 zh 下不会反向回落（现状如此）', () => {
  // ⚠️ 疑似缺陷：回落链只有「当前 → zh」一向，英文独有的键在中文界面显示成键名。
  const { I } = loadI18n();
  I.DICT.en['only.en'] = 'English only';
  assert.strictEqual(I.t('only.en'), 'only.en');
  assert.deepStrictEqual(I.missing(), ['only.en']);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('当前语言命中时不产生任何缺键记录', () => {
  const I = fresh();
  I.t('sidebar.tab-files');
  I.t('settings.title');
  assert.deepStrictEqual(I.missing(), []);
  assert.deepStrictEqual(I.missingVars(), []);
});

// ── t：占位符 ──────────────────────────────────────────────────

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('占位符按 vars 替换，中文句子逐字成形', () => {
  const I = fresh();
  assert.strictEqual(
    I.t('status.hint-open', { dir: '⌘O', file: '⌘P' }),
    '按 ⌘O 打开（最近 / 目录 / 文件），或按 ⌘P 直接打开一份文档'
  );
  assert.deepStrictEqual(I.missingVars(), []);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('缺参数不抛、也不挡住整句：位置留空并记 key:param', () => {
  const I = fresh();
  const s = I.t('status.hint-open', { dir: '⌘O' });
  assert.strictEqual(s, '按 ⌘O 打开（最近 / 目录 / 文件），或按  直接打开一份文档');
  assert.deepStrictEqual(I.missingVars(), ['status.hint-open:file']);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('完全不传 vars 时每个占位符都留空、都记账（按模板顺序）', () => {
  const I = fresh();
  assert.strictEqual(I.t('status.hint-open'), '按  打开（最近 / 目录 / 文件），或按  直接打开一份文档');
  assert.deepStrictEqual(I.missingVars(), ['status.hint-open:dir', 'status.hint-open:file']);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('值为 undefined / null 都算缺参；0 / false 是有效值', () => {
  const I = fresh();
  assert.strictEqual(I.t('settings.custom', { value: 0 }), '自定义 0');
  assert.strictEqual(I.t('settings.custom', { value: false }), '自定义 false');
  assert.strictEqual(I.t('settings.custom', { value: undefined }), '自定义 ');
  assert.strictEqual(I.t('settings.custom', { value: null }), '自定义 ');
  assert.deepStrictEqual(I.missingVars(), ['settings.custom:value'], '同一 key:param 只记一次');
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('多给的 vars 被忽略，不会出现在结果里', () => {
  const I = fresh();
  assert.strictEqual(I.t('settings.custom', { value: 'A', other: 'B' }), '自定义 A');
  assert.strictEqual(I.t('settings.custom', { value: 'A' }).indexOf('B'), -1);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('短语无占位符时 vars 完全不参与', () => {
  const I = fresh();
  assert.strictEqual(I.t('settings.title', { value: 'X' }), '设置');
  assert.deepStrictEqual(I.missingVars(), []);
});

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('带键位占位符的那句两种语言都保留 {key}（⛔ 不写死某个键）', () => {
  const I = fresh();
  assert.strictEqual(I.t('sidebar.collapse-key', { key: '⌘B' }), '收起侧边栏（⌘B）');
  I.setLang('en');
  assert.strictEqual(I.t('sidebar.collapse-key', { key: '⌘B' }), 'Collapse Sidebar (⌘B)');
});

// ── has ────────────────────────────────────────────────────────

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('has：默认查当前语言，也可显式查另一本；未知语言先归一', () => {
  const I = fresh();
  assert.strictEqual(I.has('sidebar.tab-files'), true);
  assert.strictEqual(I.has('sidebar.tab-files', 'en'), true);
  assert.strictEqual(I.has('sidebar.tab-files', 'en-US'), true);
  assert.strictEqual(I.has('sidebar.tab-files', 'fr'), true, 'fr 归一成 zh');
  assert.strictEqual(I.has('no.such.key'), false);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('has 只认字符串值：数值 / null / 空串都不算有', () => {
  const { I } = loadI18n();
  I.DICT.zh.num = 5;
  I.DICT.zh.nil = null;
  I.DICT.zh.empty = '';
  assert.strictEqual(I.has('num'), false);
  assert.strictEqual(I.has('nil'), false);
  assert.strictEqual(I.has('empty'), true, '空串仍是 string（现状如此）');
});

// ── setLang：先 DOM 后订阅者 ───────────────────────────────────

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('setLang 改写 <html lang>：zh → zh-CN，en → en（⛔ 不写死一个值）', () => {
  const { doc, langAttrs } = makeDoc({});
  const { I } = loadI18n({ document: doc });
  I.setLang('zh');
  I.setLang('en');
  I.setLang('en-US');
  I.setLang('unknown');
  assert.deepStrictEqual(langAttrs, ['zh-CN', 'en', 'en', 'zh-CN']);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('setLang 的顺序承重：applyDom 先于订阅者，订阅者读到新语言', () => {
  const order = [];
  const node = makeNode({ 'data-i18n': 'settings.title' });
  const { doc } = makeDoc({ '[data-i18n]': [node] });
  const { I } = loadI18n({ document: doc });
  I.subscribe(function (l) {
    order.push(['listener', l, node.textContent]);
  });
  const realQ = doc.querySelectorAll;
  doc.querySelectorAll = function (sel) {
    order.push(['applyDom', sel]);
    return realQ(sel);
  };
  I.setLang('en');
  const applyCalls = order.filter(function (x) { return x[0] === 'applyDom'; });
  const listener = order.filter(function (x) { return x[0] === 'listener'; });
  assert.strictEqual(applyCalls.length, 4, '四类选择器都先重贴');
  assert.deepStrictEqual(listener, [['listener', 'en', 'Settings']]);
  assert.ok(order.indexOf(listener[0]) > order.indexOf(applyCalls[3]), '订阅者在 applyDom 之后');
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('订阅者收到的是归一后的语言；同语言重设也会通知（现状如此）', () => {
  const I = fresh();
  const got = [];
  I.subscribe(function (l) { got.push(l); });
  I.setLang('en-US');
  I.setLang('en');
  I.setLang('ZH');
  assert.deepStrictEqual(got, ['en', 'en', 'zh']);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('一个订阅者抛错不挡其余，并记到 stderr', () => {
  const I = fresh();
  const got = [];
  I.subscribe(function () { throw new Error('覆盖层坏了'); });
  I.subscribe(function (l) { got.push(l); });
  const r = silence(function () { I.setLang('en'); });
  assert.deepStrictEqual(got, ['en']);
  assert.strictEqual(r.logs.length, 1);
  assert.ok(r.logs[0].indexOf('覆盖层坏了') >= 0);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('退订后不再收到；重复退订安全；非函数订阅返回空操作', () => {
  const I = fresh();
  const got = [];
  const off = I.subscribe(function (l) { got.push(l); });
  off();
  off();
  I.setLang('en');
  assert.deepStrictEqual(got, []);
  assert.doesNotThrow(function () { I.subscribe(null)(); });
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('没有 document 时 setLang 只换字典，⛔ 不抛', () => {
  const I = fresh();
  assert.doesNotThrow(function () { I.setLang('en'); });
  assert.strictEqual(I.t('sidebar.tab-files'), 'Files');
});

// ── applyDom：四类 data-i18n* ──────────────────────────────────

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('四类选择器各写各的属性：textContent / title / placeholder / aria-label', () => {
  const text = makeNode({ 'data-i18n': 'settings.title' });
  const title = makeNode({ 'data-i18n-title': 'sidebar.open-dir-title' });
  const ph = makeNode({ 'data-i18n-placeholder': 'sidebar.search-placeholder' });
  const aria = makeNode({ 'data-i18n-aria-label': 'sidebar.search-label' });
  const { doc } = makeDoc({
    '[data-i18n]': [text],
    '[data-i18n-title]': [title],
    '[data-i18n-placeholder]': [ph],
    '[data-i18n-aria-label]': [aria],
  });
  const { I } = loadI18n({ document: doc });
  assert.strictEqual(I.applyDom(), 4);
  assert.strictEqual(text.textContent, '设置');
  assert.deepStrictEqual(title.setAttrs, [['title', '打开目录']]);
  assert.deepStrictEqual(ph.setAttrs, [['placeholder', '搜索文件名…']]);
  assert.deepStrictEqual(aria.setAttrs, [['aria-label', '按文件名搜索']]);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('applyDom 幂等：第二次没有变化就不计数、也不重写', () => {
  const node = makeNode({ 'data-i18n': 'settings.title' });
  const { doc } = makeDoc({ '[data-i18n]': [node] });
  const { I } = loadI18n({ document: doc });
  assert.strictEqual(I.applyDom(), 1);
  const writes = node.setAttrs.length;
  assert.strictEqual(I.applyDom(), 0);
  assert.strictEqual(node.setAttrs.length, writes);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('applyDom 按当前语言重贴：切到 en 后节点变英文', () => {
  const node = makeNode({ 'data-i18n': 'settings.title' });
  const { doc } = makeDoc({ '[data-i18n]': [node] });
  const { I } = loadI18n({ document: doc });
  I.applyDom();
  assert.strictEqual(node.textContent, '设置');
  I.setLang('en');
  assert.strictEqual(node.textContent, 'Settings');
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('空的 data-i18n 属性被跳过，⛔ 不当成空键去污染 missing', () => {
  const empty = makeNode({ 'data-i18n': '' });
  const missing = makeNode({});
  const good = makeNode({ 'data-i18n': 'settings.title' });
  const { doc } = makeDoc({ '[data-i18n]': [empty, missing, good] });
  const { I } = loadI18n({ document: doc });
  assert.strictEqual(I.applyDom(), 1);
  assert.deepStrictEqual(I.missing(), []);
  assert.strictEqual(empty.textContent, 'OLD');
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('缺键的节点写入键名本身（现状如此，比留空可诊断）', () => {
  const node = makeNode({ 'data-i18n': 'no.such.key' });
  const { doc } = makeDoc({ '[data-i18n]': [node] });
  const { I } = loadI18n({ document: doc });
  assert.strictEqual(I.applyDom(), 1);
  assert.strictEqual(node.textContent, 'no.such.key');
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('applyDom 只写文本与属性，⛔ 不碰 innerHTML（渲染只在 Rust 侧）', () => {
  let htmlWrites = 0;
  const node = makeNode({ 'data-i18n': 'settings.title' });
  Object.defineProperty(node, 'innerHTML', {
    set: function () { htmlWrites += 1; },
    get: function () { return 'ORIGINAL'; },
  });
  const { doc } = makeDoc({ '[data-i18n]': [node] });
  const { I } = loadI18n({ document: doc });
  I.applyDom();
  assert.strictEqual(htmlWrites, 0);
  assert.strictEqual(node.innerHTML, 'ORIGINAL');
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('applyDom 不做占位符替换：带 {key} 的句子会贴成空括号并记缺参（所以⛔ 别放进 data-i18n）', () => {
  const node = makeNode({ 'data-i18n-title': 'sidebar.collapse-key' });
  const { doc } = makeDoc({ '[data-i18n-title]': [node] });
  const { I } = loadI18n({ document: doc });
  I.applyDom();
  assert.deepStrictEqual(node.setAttrs, [['title', '收起侧边栏（）']]);
  assert.deepStrictEqual(I.missingVars(), ['sidebar.collapse-key:key']);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('root 缺 querySelectorAll / 为空时返回 0，⛔ 不抛', () => {
  const I = fresh();
  assert.strictEqual(I.applyDom({}), 0);
  assert.strictEqual(I.applyDom(null), 0);
  assert.strictEqual(I.applyDom({ querySelectorAll: 'nope' }), 0);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('不传 root 时用注入的 window.document', () => {
  const node = makeNode({ 'data-i18n': 'settings.title' });
  const { doc } = makeDoc({ '[data-i18n]': [node] });
  const { I } = loadI18n({ document: doc });
  assert.strictEqual(I.applyDom(), 1);
  assert.strictEqual(node.textContent, '设置');
});

// ── 字典完整性：两本必须同构 ───────────────────────────────────

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('zh / en 键集完全相同（⛔ 不许某条只进一本）', () => {
  const I = fresh();
  const zh = Object.keys(I.DICT.zh).sort();
  const en = Object.keys(I.DICT.en).sort();
  assert.deepStrictEqual(en, zh);
  assert.strictEqual(zh.length, 400);
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('每一条都是非空字符串', () => {
  const I = fresh();
  for (const l of ['zh', 'en']) {
    for (const k of Object.keys(I.DICT[l])) {
      assert.strictEqual(typeof I.DICT[l][k], 'string', l + ':' + k);
      assert.ok(I.DICT[l][k].length > 0, l + ':' + k + ' 是空串');
    }
  }
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('同一条的占位符集合在中英之间完全一致（⛔ 不许张冠李戴）', () => {
  const I = fresh();
  const vars = function (s) {
    return Array.from(new Set(s.match(/\{\w+\}/g) || [])).sort();
  };
  for (const k of Object.keys(I.DICT.zh)) {
    assert.deepStrictEqual(vars(I.DICT.en[k]), vars(I.DICT.zh[k]), k);
  }
});

// 源自 docs/bugs/0193（L2语言写死zh且不进产物）
test('键名是扁平点分串：无空段、无空白', () => {
  const I = fresh();
  for (const k of Object.keys(I.DICT.zh)) {
    assert.strictEqual(/\s/.test(k), false, k);
    assert.strictEqual(/^\.|\.\.|\.$/.test(k), false, k);
  }
});

// ── 语言选项：设置面板的三条 ───────────────────────────────────

// 源自 docs/bugs/0007（外观只存住了主题）
test('语言三个选项在中英两本里都在，且中文名不翻译', () => {
  const I = fresh();
  assert.strictEqual(I.t('settings.language'), '语言');
  assert.strictEqual(I.t('settings.lang.system'), '跟随系统');
  assert.strictEqual(I.t('settings.lang.zh'), '中文');
  assert.strictEqual(I.t('settings.lang.en'), 'English');
  I.setLang('en');
  assert.strictEqual(I.t('settings.language'), 'Language');
  assert.strictEqual(I.t('settings.lang.system'), 'System');
  assert.strictEqual(I.t('settings.lang.zh'), '中文');
  assert.strictEqual(I.t('settings.lang.en'), 'English');
});

// 源自 docs/bugs/0007（外观只存住了主题）
test('跟随系统也是一个显式选项，⛔ 不是"没有语言设置"', () => {
  const I = fresh();
  assert.strictEqual(I.has('settings.lang.system'), true);
  assert.strictEqual(I.has('settings.lang.system', 'en'), true);
  assert.strictEqual(I.t('settings.lang.system'), '跟随系统');
});

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('两条渲染统计文案在两本字典里都在，且占位符都是 un / all', () => {
  const I = fresh();
  for (const k of ['doc.code-unhighlighted', 'doc.diagrams-unrendered']) {
    assert.strictEqual(I.has(k), true, k);
    assert.strictEqual(I.has(k, 'en'), true, k);
    assert.deepStrictEqual((I.DICT.zh[k].match(/\{\w+\}/g) || []).sort(), ['{all}', '{un}'], k);
    assert.deepStrictEqual((I.DICT.en[k].match(/\{\w+\}/g) || []).sort(), ['{all}', '{un}'], k);
  }
});

// 源自 docs/bugs/0074（Mermaid-命名实体码原样显示）
test('英文的图表那句说 source is intact，⛔ 不说丢了内容', () => {
  const I = fresh();
  const en = I.DICT.en['doc.diagrams-unrendered'];
  assert.ok(en.indexOf('intact') >= 0);
  assert.strictEqual(en.toLowerCase().indexOf('lost'), -1);
  assert.ok(I.DICT.zh['doc.diagrams-unrendered'].indexOf('原文完整') >= 0);
});
