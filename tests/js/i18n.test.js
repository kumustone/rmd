// `design/0025` §7.2 的 JS 单测：**界面中英双语**（`src/services/i18n.js`）＋ 两道源码级闸门。
//
// ⭐ 这一格测的全是**不报错的失效形态**——它们每一条都能让程序跑得好好的，
//    只是屏幕上的字不对：
//
//   ① **键集合不等**：`en` 少一条 ⇒ 那一处**静默**回落中文（`t()` 的设计如此），
//      表现是"英文界面里冒出一句中文"，而没有任何日志。
//   ② **占位符集合不等**：少一个 `{n}` ⇒ 句子缺一块（`已打开目录 （根 3 个）`），
//      少一个调用方多给的 ⇒ 无事发生，但下次改成 `t()` 时才发现模板对不上。
//   ③ ⭐ **重复键**：JS 对象字面量**后者覆盖前者**、⛔ 不报错。
//      2026-10-21 实施时真踩到过——14 个 `sidebar.*` 键被插了两遍，
//      屏幕上看不出任何异常（两份值恰好一样），但下一次只改其中一份就会**永远读不到**。
//      ⛔ `node` 与现有任何闸门都**不报**这件事，所以只能在这里查源码。
//   ④ ⭐ **漏翻**：一条中文字面量直接进了 `textContent`。它**不在字典里**，
//      所以"每个 `t()` 的键都存在"那条**单向**闸门永远抓不到它。
//      ⇒ §7.2 要求补一条**反方向**的源码闸门：`src/**` 里每条含汉字的字符串字面量
//      必须"**要么在诊断白名单里、要么走 `t()`**"。
//   ⑤ **脚本位次**：`i18n.js` 排在某个使用者之后 ⇒ 那个文件在加载期取到 `null`，
//      表现与 `design/0009` §10.3 实测过的 `search.js` 同族：**用到时才炸**，
//      启动路径上一个症状都没有。
//
// ⚠️ **白名单是显式的、逐条的**（⛔ 不是"含 `console` 就放过"——那会把
//    `setStatus('⛔ …')` 一起放过，而它恰恰是最该拦的那一类）。
//    ⭐ 并且**双向**：白名单里的每一条都必须**仍然存在**于那个文件里——
//    否则删掉文案之后白名单会慢慢烂成"一张谁也不敢动的许可清单"。
//
// 跑法：`make test-js`（= `node --test tests/js/`）。
// ⚠️ 放在仓库根的 `tests/js/` 而不是 `src/`：`src/` 是 Tauri 的 `frontendDist`，
//    整个目录**会在编译期嵌进二进制**。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const I = require('../../src/services/i18n.js');

const SRC = path.resolve(__dirname, '../../src');
const INDEX_HTML = path.join(SRC, 'index.html');
const DICT_FILE = 'services/i18n.js';

/** 汉字区间：基本区（够用——本项目的界面文案只用基本区）。 */
const CJK = /[㐀-鿿]/;

// ────────────────────────────────────────────────────────────────
// 源码工具（与 `keymap.test.js` 那族同形：⛔ 注释不算实现）
// ────────────────────────────────────────────────────────────────

/**
 * 从 `open` 处的引号开始，返回**闭引号之后**的下标（未闭合时返回 `n`）。
 */
function skipString(src, open) {
  const q = src[open];
  let i = open + 1;
  const n = src.length;
  while (i < n) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    i += 1;
  }
  return n;
}

/**
 * 把注释**挖成空格**（⛔ 不是删掉）——行号必须与原文一一对应。
 * ⚠️ 字符串**原样保留**：判断"这是不是一个字面量"必须看得到它。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const j = skipString(src, i);
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 扫一份**已去注释**的源码里的字符串字面量。
 * @returns {{line:number, text:string, quote:string}[]}
 */
function scanLiterals(code) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const start = line;
      const end = skipString(code, i);
      const raw = code.slice(i, end);
      // 去掉两端引号；转义原样保留（比较的是**源码里的那个串**，不是运行期的值）。
      const text = raw.length >= 2 && raw[raw.length - 1] === c ? raw.slice(1, -1) : raw.slice(1);
      line += (raw.match(/\n/g) || []).length;
      out.push({ line: start, text: text, quote: c });
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/** `open` 处那个 `{` 的配对 `}` 下标（跳过字符串里的花括号）。未配对返回 -1。 */
function matchBrace(code, open) {
  let depth = 0;
  let i = open;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(code, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function walk(dir, out, re) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, re);
    else if (re.test(e.name)) out.push(p);
  });
  return out;
}

/** `src/**` 下的全部 `.js`（⚠️ 含产物 `vendor/cm6.bundle.js`，调用方自己排除）。 */
const JS_FILES = walk(SRC, [], /\.js$/).map(function (p) {
  return { rel: path.relative(SRC, p), text: fs.readFileSync(p, 'utf8') };
});

function fileText(rel) {
  const f = JS_FILES.find(function (x) { return x.rel === rel; });
  assert.ok(f, '`src/' + rel + '` 不在了——闸门的锚点失效');
  return f.text;
}

// ────────────────────────────────────────────────────────────────
// ① 字典的形状：键集合 / 占位符 / 空值 / 重复键
// ────────────────────────────────────────────────────────────────

const ZH = I.DICT.zh;
const EN = I.DICT.en;

function placeholderSet(tpl) {
  const s = new Set();
  (tpl.match(/\{(\w+)\}/g) || []).forEach(function (m) { s.add(m.slice(1, -1)); });
  return s;
}

test('两本字典的键集合**双向**相等（`INV-I18N-03`）', function () {
  const zhKeys = Object.keys(ZH).sort();
  const enKeys = Object.keys(EN).sort();
  const onlyZh = zhKeys.filter(function (k) { return !(k in EN); });
  const onlyEn = enKeys.filter(function (k) { return !(k in ZH); });
  assert.deepStrictEqual(onlyZh, [], '只有中文、英文缺：' + onlyZh.join(', '));
  assert.deepStrictEqual(onlyEn, [], '只有英文、中文缺：' + onlyEn.join(', '));
  assert.ok(zhKeys.length > 100, '字典只有 ' + zhKeys.length + ' 条 —— 扫描器或文件都出问题了');
});

test('每个键的**占位符集合**也相等（少一个参数 = 句子缺一块，屏幕上不报错）', function () {
  const bad = [];
  Object.keys(ZH).forEach(function (k) {
    if (!(k in EN)) return;              // 上一条已经报过
    const a = placeholderSet(ZH[k]);
    const b = placeholderSet(EN[k]);
    const onlyA = Array.from(a).filter(function (x) { return !b.has(x); });
    const onlyB = Array.from(b).filter(function (x) { return !a.has(x); });
    if (onlyA.length || onlyB.length) {
      bad.push(k + ' zh缺[' + onlyB.join(',') + '] en缺[' + onlyA.join(',') + ']');
    }
  });
  assert.deepStrictEqual(bad, []);
});

test('两本字典**没有空值**、没有非字符串值', function () {
  ['zh', 'en'].forEach(function (l) {
    const d = I.DICT[l];
    Object.keys(d).forEach(function (k) {
      assert.strictEqual(typeof d[k], 'string', l + '.' + k + ' 不是字符串');
      assert.ok(d[k].length > 0, l + '.' + k + ' 是空串');
    });
  });
});

test('⭐ 字典里**没有重复键**（后者会**静默**覆盖前者，`node` 不报）', function () {
  const code = stripComments(fileText(DICT_FILE));

  function blockOf(lang) {
    const dictAt = code.indexOf('const DICT = {');
    assert.ok(dictAt >= 0, '`i18n.js` 里找不到 `const DICT = {` —— 扫描器锚点失效');
    const open = code.indexOf('{', dictAt);
    const close = matchBrace(code, open);
    assert.ok(close > open, '`DICT` 的花括号没配对');
    const body = code.slice(open + 1, close);
    const at = body.indexOf(lang + ': {');
    assert.ok(at >= 0, '字典里找不到 `' + lang + ': {`');
    const o = body.indexOf('{', at);
    const c = matchBrace(body, o);
    assert.ok(c > o, lang + ' 那一块的花括号没配对');
    return body.slice(o + 1, c);
  }

  ['zh', 'en'].forEach(function (l) {
    const block = blockOf(l);
    const keys = [];
    const re = /^[ \t]*'([^']+)':/gm;
    let m;
    while ((m = re.exec(block))) keys.push(m[1]);
    const seen = Object.create(null);
    const dups = [];
    keys.forEach(function (k) {
      if (seen[k]) dups.push(k);
      seen[k] = true;
    });
    assert.ok(keys.length > 100, l + ' 只扫到 ' + keys.length + ' 个键 —— 正则失效了？');
    assert.deepStrictEqual(dups, [], l + ' 有重复键：' + dups.join(', '));
    // ⭐ 顺带钉住"源码里的键数 == 运行期的键数"——只有这一条能证明上面的扫描**确实**覆盖全。
    assert.strictEqual(keys.length, Object.keys(I.DICT[l]).length,
      l + ' 源码里 ' + keys.length + ' 个键，运行期 ' + Object.keys(I.DICT[l]).length
      + ' 个 —— 说明扫描漏了行（续行？嵌套？），这条闸门已经不覆盖全字典了');
  });
});

// ────────────────────────────────────────────────────────────────
// ② `t()` 的行为：回落链 / 参数 / 缺参数 / 多参数
// ────────────────────────────────────────────────────────────────

test('回落链是 **当前语言 → 中文 → 键本身**，且 `t()` 永不返回空串', function () {
  const K = 'zz.test-only-in-zh';
  const before = I.lang();
  try {
    I.DICT.zh[K] = '只有中文有这一条';
    I.setLang('en');
    assert.strictEqual(I.t(K), '只有中文有这一条', '英文缺时必须回落中文，⛔ 不是键');

    I.setLang('zh');
    assert.strictEqual(I.t('zz.no.such.key.at.all'), 'zz.no.such.key.at.all',
      '两本都缺时必须**显示键本身**（比空白强：它自己说明是缺哪一条）');
    assert.notStrictEqual(I.t('zz.no.such.key.at.all'), '');
    // ⚠️ **空键**是回落链唯一给不出非空串的输入（`String(key)` 就是 `''`）
    //    ⇒ 实现里给了 "(i18n: empty key)" 这个 ASCII 标记，⛔ 不是回落成空白。
    assert.notStrictEqual(I.t(''), '', '空键也不许返回空串');
  } finally {
    delete I.DICT.zh[K];
    I.setLang(before);
  }
});

test('占位符替换；缺参数**不抛**、留空并登记；多余的参数被忽略', function () {
  const before = I.lang();
  try {
    I.setLang('zh');
    assert.strictEqual(I.t('search.age-seconds', { n: 3 }), '3 秒前');
    assert.strictEqual(I.t('search.age-seconds', { n: 3, 不认识的: 'x' }), '3 秒前',
      '多余的参数必须被忽略（⛔ 不许拼进句子）');

    const empty = I.t('search.age-seconds');
    assert.strictEqual(typeof empty, 'string');
    assert.strictEqual(empty, ' 秒前', '缺参数时占位符换成空串，⛔ 不许把 `{n}` 原样印出来');
    assert.ok(I.missingVars().indexOf('search.age-seconds:n') >= 0,
      '缺参数必须被登记（`missingVars()` 里没有 `search.age-seconds:n`）');
  } finally {
    I.setLang(before);
  }
});

test('`normalizeLang` 把线上各种形态归一，未知值一律出厂语言 `zh`', function () {
  assert.strictEqual(I.normalizeLang('en'), 'en');
  assert.strictEqual(I.normalizeLang('en-US'), 'en');
  assert.strictEqual(I.normalizeLang('EN-US'), 'en');
  assert.strictEqual(I.normalizeLang('EN_us'), 'zh', '下划线不是线上形状，⛔ 别为它放宽归一规则');
  assert.strictEqual(I.normalizeLang('zh'), 'zh');
  assert.strictEqual(I.normalizeLang('zh-Hans-CN'), 'zh');
  assert.strictEqual(I.normalizeLang('fr'), 'zh');
  assert.strictEqual(I.normalizeLang(null), 'zh');
  assert.strictEqual(I.normalizeLang(undefined), 'zh');
});

// ────────────────────────────────────────────────────────────────
// ③ `index.html`：`data-i18n*` 覆盖完整 + 无**未登记**的可见中文
// ────────────────────────────────────────────────────────────────

const HTML_RAW = fs.readFileSync(INDEX_HTML, 'utf8');

/** 去掉注释与 `<script>` / `<style>` 的内容（那两处的"文案"不是界面文案）。 */
const HTML = HTML_RAW
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ');

const HTML_TAGS = HTML.match(/<[a-zA-Z][^<>]*>/g) || [];

test('夹具自检：`index.html` 扫得出标签与 `data-i18n*`', function () {
  assert.ok(HTML_TAGS.length >= 50, '只扫到 ' + HTML_TAGS.length + ' 个标签 —— 路径或正则错了');
  assert.ok(/"data-i18n"/.test(HTML) || /data-i18n="/.test(HTML), '一个 `data-i18n` 都没有');
});

test('`index.html` 每个 `data-i18n*` 的键在**两本**字典里都存在', function () {
  const re = /data-i18n(?:-title|-placeholder|-aria-label)?\s*=\s*"([^"]+)"/g;
  const miss = [];
  let n = 0;
  let m;
  while ((m = re.exec(HTML))) {
    n += 1;
    if (!I.has(m[1], 'zh') || !I.has(m[1], 'en')) miss.push(m[1]);
  }
  assert.ok(n >= 30, '只扫到 ' + n + ' 个 `data-i18n*` —— 正则失效了？');
  assert.deepStrictEqual(miss, [], '这些键不在字典里：' + miss.join(', '));
});

test('`index.html` 里的**出厂文案**与字典的 zh 值逐字相等', function () {
  // ⚠️ 为什么钉这一条：HTML 里保留的中文是**首帧的兜底**（脚本没跑起来时也看得见），
  //    它漂了不会报错——只是首帧和运行期显示**两句不一样的话**。
  const re = /data-i18n="([^"]+)"[^>]*>([^<]*)</g;
  const diff = [];
  let m;
  while ((m = re.exec(HTML))) {
    const k = m[1];
    const v = m[2];
    if (!v.trim()) continue;              // 空标签（仅靠脚本填）不在此列
    if (ZH[k] !== v) diff.push(k + '：字典=' + JSON.stringify(ZH[k]) + ' HTML=' + JSON.stringify(v));
  }
  assert.deepStrictEqual(diff, []);
});

test('⭐ `index.html` 无**未登记**的可见中文（`design/0025` §7.2 的"无残留可见中文"）', function () {
  // ⚠️ 判据**不是**"HTML 里一个汉字都没有"：文件里保留的中文是**出厂文案**，
  //    也是脚本没跑起来时的兜底（`index.html` 里那条注释写明了理由）。
  //    ⇒ 真正的判据是「**每一处可见中文都有 `data-i18n*` 登记**」——
  //    没有登记的那一处，切到英文之后**永远不会变**，而屏幕其他地方全变了。
  const bad = [];

  // ① 文本节点：中文必须落在带 `data-i18n` 的那个元素里。
  const textRe = />([^<]+)</g;
  let m;
  while ((m = textRe.exec(HTML))) {
    const txt = m[1];
    if (!CJK.test(txt)) continue;
    const at = HTML.lastIndexOf('<', m.index);
    const tag = at >= 0 ? HTML.slice(at, m.index + 1) : '';
    if (!/data-i18n="[^"]+"/.test(tag)) bad.push('文本 ' + JSON.stringify(txt.trim()) + ' 在 ' + tag.slice(0, 80));
  }

  // ② 属性：`title` / `placeholder` / `aria-label` / `alt` 各要对应的那一类。
  const PAIRS = [
    ['title', 'data-i18n-title'],
    ['placeholder', 'data-i18n-placeholder'],
    ['aria-label', 'data-i18n-aria-label'],
    ['alt', 'data-i18n-alt'],
  ];
  HTML_TAGS.forEach(function (tag) {
    PAIRS.forEach(function (p) {
      const am = tag.match(new RegExp('\\s' + p[0] + '\\s*=\\s*"([^"]*)"'));
      if (!am || !CJK.test(am[1])) return;
      if (tag.indexOf(p[1]) < 0) {
        bad.push('属性 ' + p[0] + '=' + JSON.stringify(am[1].slice(0, 40)) + ' 在 ' + tag.slice(0, 80));
      }
    });
  });

  assert.deepStrictEqual(bad, [], '这些中文没有 `data-i18n*` 登记（切英文时它们不会变）：\n' + bad.join('\n'));
});

// ────────────────────────────────────────────────────────────────
// ④ 源码里的键：`t('…')` 字面量 / `data-i18n` 字面量 / 拼接调用
// ────────────────────────────────────────────────────────────────

test('`src/**` 里每个 `t(\'…\')` 字面量键都在**两本**字典里', function () {
  const miss = [];
  let n = 0;
  JS_FILES.forEach(function (f) {
    if (f.rel === DICT_FILE) return;
    const code = stripComments(f.text);
    const re = /(?<![A-Za-z0-9_$])t\(\s*(['"])([^'"]*?)\1\s*[),]/g;
    let m;
    while ((m = re.exec(code))) {
      n += 1;
      if (!I.has(m[2], 'zh') || !I.has(m[2], 'en')) miss.push(f.rel + ': ' + m[2]);
    }
  });
  assert.ok(n >= 50, '只扫到 ' + n + ' 处 `t(\'…\')` —— 正则或源码出问题了');
  assert.deepStrictEqual(miss, [], '这些键不在字典里：\n' + miss.join('\n'));
});

test('⭐ 零 `t(\'…\' + …)` 拼接调用（§2.2.1：先改成模板，再翻译）', function () {
  // ⚠️ 拼接出来的句子**没法逐条翻译**：一半中文一半英文，而且切成两条键之后
  //    语序会错（英文的 "2 seconds ago" vs 中文的 "2 秒前"）。
  const bad = [];
  JS_FILES.forEach(function (f) {
    if (f.rel === DICT_FILE) return;
    const code = stripComments(f.text);
    const re = /(?<![A-Za-z0-9_$])t\(\s*(['"])[^'"]*\1\s*\+/g;
    let m;
    while ((m = re.exec(code))) {
      bad.push(f.rel + ':' + (code.slice(0, m.index).match(/\n/g) || []).length);
    }
  });
  assert.deepStrictEqual(bad, [], '这些 `t()` 调用在**拼字符串**：' + bad.join(', '));
});

test('`src/**` 里 JS 侧的 `data-i18n*` 键也在两本字典里', function () {
  // ⚠️ 与 `t()` 分开查：这些键不由 `t()` 调，漏查就永远没人发现。
  const bad = [];
  JS_FILES.forEach(function (f) {
    if (f.rel === DICT_FILE) return;
    const re = /data-i18n(?:-title|-placeholder|-aria-label)?["']?\s*[,:)]?\s*["']([a-z0-9.\-]+)["']/g;
    let m;
    while ((m = re.exec(stripComments(f.text)))) {
      if (!I.has(m[1], 'zh') || !I.has(m[1], 'en')) bad.push(f.rel + ': ' + m[1]);
    }
  });
  assert.deepStrictEqual(bad, []);
});

test('⭐⭐ `tag()` / `el()` 的**字面量字典键**必须真在字典里（空串与装饰字都不行）', function () {
  // ⚠️⚠️ 这条是 `design/0025` §7.2 的**真 DOM 探针**抓回来的（2026-10-21）：
  //    `Settings.js` 里 `el('span', 'settings-value', '')` —— `el()`/`tag()` 的参数是**字典键**，
  //    空串不是"没有键"而是"给了一个空键"：`tag()` 照样 `setAttribute('data-i18n','')`，
  //    于是 ① 工厂文案被写成 `(i18n: empty key)`；② `applyDom()` 每次换语言还再贴一次，
  //    而 `render()` 只在 `open()` 时跑 ⇒ **开着设置改一次语言，字号那个数字就变成那串标记**。
  //    ⚠️ 它同时污染 `missing()`（自检永远带一条空键）。
  // ⚠️ 同一遍扫描还抓到 **装饰字被当成键**（`el('button', …, '↑')`）：`t('↑')` 回落到键本身
  //    ⇒ 看上去没事，但那两格从此永远算"缺键"，而且哪天真的补了同名字的键，按钮就变字了。
  // ⚠️ 静态扫描**单独存在**的理由：另外八个组件（`Sidebar`/`FileTree`/`QuickOpen`/…）
  //    都在运行时建 DOM，探针**不加载**它们 ⇒ 探针只覆盖 `index.html` 与 `Settings.js`。
  const EMPTY_ATTR = /data-i18n(?:-title|-placeholder|-aria-label)?\s*=\s*(['"])\1/g;
  // `el(标签, 类名, '键')`：第三个参数才是键；`tag(节点, '键')`：第二个参数。
  // ⚠️ 参数里出现括号/逗号就跳过（本仓库没那么写的调用）——⛔ 宁可漏扫也不误报。
  const CALLS = [
    { re: /(?<![A-Za-z0-9_$.])el\(\s*[^,()]+,\s*[^,()]+,\s*(['"])([^'"]*)\1\s*[,)]/g, key: 2 },
    { re: /(?<![A-Za-z0-9_$.])tag\(\s*[^,()]+,\s*(['"])([^'"]*)\1\s*[,)]/g, key: 2 }
  ];
  const bad = [];
  let n = 0;
  JS_FILES.forEach(function (f) {
    const code = stripComments(f.text);
    // 自检用的计数：证明扫描面确实贴着 `tag(`/`el(` 的真实调用
    n += (code.match(/(?<![A-Za-z0-9_$.])(?:tag|el)\(/g) || []).length;
    EMPTY_ATTR.lastIndex = 0;
    let m;
    while ((m = EMPTY_ATTR.exec(code))) {
      bad.push(f.rel + ':' + (code.slice(0, m.index).match(/\n/g) || []).length + ' 空 data-i18n');
    }
    CALLS.forEach(function (c) {
      c.re.lastIndex = 0;
      let mm;
      while ((mm = c.re.exec(code))) {
        const k = mm[c.key];
        if (!k) {
          bad.push(f.rel + ':' + (code.slice(0, mm.index).match(/\n/g) || []).length + ' 空字典键');
        } else if (!I.has(k, 'zh') || !I.has(k, 'en')) {
          bad.push(f.rel + ':' + (code.slice(0, mm.index).match(/\n/g) || []).length + ' ' + k);
        }
      }
    });
  });
  assert.ok(n >= 20, '只扫到 ' + n + ' 处 `tag(`/`el(` 调用 —— 注释剥离把代码也剥掉了？');
  assert.deepStrictEqual(bad, [], '这些地方给的字典键不在字典里 / 是空的：' + bad.join(', '));
});



test('⭐ `services/i18n.js` 必须是**第一条**非产物脚本（`INV-I18N-06`）', function () {
  const order = (HTML_RAW.match(/<script[^>]*src="([^"]+)"/g) || []).map(function (s) {
    return (s.match(/src="([^"]+)"/) || [])[1];
  });
  assert.ok(order.length >= 15, '`index.html` 里只扫到 ' + order.length + ' 个 `<script src>`');
  assert.strictEqual(order[0], 'vendor/cm6.bundle.js', '第一项必须是 CM6 产物');
  assert.strictEqual(order[1], 'services/i18n.js',
    '`i18n.js` 必须是第二条 —— 现在第二条是 `' + order[1] + '`');
});

// ────────────────────────────────────────────────────────────────
// ⑥ 后端拒绝的七类：词都在、都非空、互不相同、不是兜底那句（评审 #7）
// ────────────────────────────────────────────────────────────────

test('⭐ `tauri.js` 的每个 `kind` 都有 zh 词，且**互不相同**、都不是兜底那句', function () {
  const code = stripComments(fileText('services/tauri.js'));
  const at = code.indexOf('const KIND_KEY = {');
  assert.ok(at >= 0, '`tauri.js` 里找不到 `const KIND_KEY = {`');
  const open = code.indexOf('{', at);
  const close = matchBrace(code, open);
  const body = code.slice(open + 1, close);

  const map = {};
  const re = /([A-Za-z_][\w]*)\s*:\s*'(err\.kind\.[\w.\-]+)'/g;
  let m;
  while ((m = re.exec(body))) map[m[1]] = m[2];

  // ⚠️ 这张清单是**后端错误变体的镜像**：后端加一类、这里就得加一行。
  //    ⛔ 不是"冻结字面清单"——它与 `error.rs` 的变体一一对应，漏了会在这里红。
  const EXPECT = [
    'not_authorized', 'not_found', 'stale', 'io', 'conflict', 'save_in_flight', 'no_document',
    // ⭐ `design/0034`（新建文件/目录）：四类新的拒绝
    'already_exists', 'invalid_name', 'unusable_parent', 'created_outside_root',
    // ⭐ `design/0035`（重命名）：一类新的拒绝（`reason` 在 `raw.reason` 里细分）
    'not_renamable',
  ];
  assert.deepStrictEqual(Object.keys(map).sort(), EXPECT.slice().sort(),
    '`KIND_KEY` 的类集合变了 —— 后端加了/删了错误变体？');

  const other = ZH['err.kind.other'];
  assert.ok(typeof other === 'string' && other.length > 0, '兜底那句不见了');
  const seen = Object.create(null);
  EXPECT.forEach(function (k) {
    const key = map[k];
    assert.ok(I.has(key, 'zh') && I.has(key, 'en'), k + ' → ' + key + ' 不在字典里');
    assert.ok(ZH[key].length > 0, k + ' 的中文是空的');
    assert.notStrictEqual(ZH[key], other, k + ' 用了兜底那句（语义是"我们不定义原因"）');
    assert.ok(!seen[ZH[key]], k + ' 与「' + seen[ZH[key]] + '」的措辞**完全一样** —— 两类错误说成同一句话');
    seen[ZH[key]] = k;
  });
});

// ────────────────────────────────────────────────────────────────
// ⑦ 两个"中文锚点"必须与字典逐字相等
// ────────────────────────────────────────────────────────────────

test('`renderstat.js::DEFAULT_TPL` 与字典的 `doc.code-unhighlighted` 逐字相等', function () {
  const before = I.lang();
  // ⚠️ `renderstat.js` 只挂 `window.rmd.renderstat`（没有 `module.exports`），
  //    所以给一个假 `window` 把它接住——与 `renderstat.test.js` 同一手法。
  const g = global;
  const had = Object.prototype.hasOwnProperty.call(g, 'window');
  const saved = g.window;
  g.window = {};
  try {
    require('../../src/services/renderstat.js');
    const R = g.window.rmd && g.window.rmd.renderstat;
    assert.ok(R && typeof R.DEFAULT_TPL === 'string', '`renderstat.js` 没挂上 `window.rmd.renderstat`');
    I.setLang('zh');
    // ⚠️ 比的是**字典里的裸模板**，⛔ 不是 `t()` 的结果：`t()` 会把占位符替换成空串
    //    （这里没传 `vars`），那样比的是"两个都被挖空了的句子"。
    assert.strictEqual(R.DEFAULT_TPL, I.DICT.zh['doc.code-unhighlighted']);
  } finally {
    if (had) g.window = saved;
    else delete g.window;
    I.setLang(before);
  }
});

test('`find.js::SCOPE_HINT` 与 `t(SCOPE_HINT_KEY)` 逐字相等（且它**不得**被拿去显示）', function () {
  const before = I.lang();
  try {
    const F = require('../../src/services/find.js');
    I.setLang('zh');
    assert.strictEqual(F.SCOPE_HINT, I.t(F.SCOPE_HINT_KEY));
    const bar = fileText('components/FindBar.js');
    assert.ok(bar.indexOf('F.SCOPE_HINT_KEY') >= 0, '`FindBar.js` 没有把范围那句话放上界面');
    assert.ok(bar.indexOf('F.SCOPE_HINT,') < 0 && bar.indexOf('F.SCOPE_HINT)') < 0,
      '`FindBar.js` 直接用了加载期常量 `SCOPE_HINT` —— 切语言时会冻住');
  } finally {
    I.setLang(before);
  }
});

// ────────────────────────────────────────────────────────────────
// ⑧ ⭐ 双向源码闸门：`src/**` 的每条中文字面量要么登记、要么走 `t()`
// ────────────────────────────────────────────────────────────────

/**
 * ⭐ **诊断白名单**（逐条、显式）。
 *
 * 判据：这条中文**不会**出现在窗口里——它进的是 `console.*` / `reportFatal` /
 * 自证与探针的输出，而那些地方**必须**保持中文（`make smoke` 与探针脚本
 * 按中文字串取值，见 `design/0025` §2.2「一料两出口」）。
 *
 * ⛔ **不许在这里加一条"看得见的"文案**。加之前先问：
 *   切到英文之后，这句话**还在屏幕上**吗？在 ⇒ 它该进字典。
 * ⚠️ 这条闸门**双向**：下面还有一格检查"白名单里的每条都还存在"。
 */
const EXEMPT = [
  // ⚠️ 生成时间：2026-10-21。格式：`[文件（相对 src/）, 字面量]`。
  // ⛔ 加一条之前先问：切到英文之后这句**还在屏幕上**吗？在 ⇒ 它该进字典。
  ["components/FindBar.js", "命中区间读出来是「"],
  ["components/FindBar.js", "正文里找不到可用的非空白词（探测不了）"],
  ["components/FindBar.js", "没有已挂载的文档"],
  ["components/FindBar.js", "索引构建超时"],
  ["components/FindBar.js", "自证抛错："],
  ["components/ImageView.js", "onSettled 回调失败："],
  ["components/Settings.js", " 出错："],
  ["components/Settings.js", "⛔ 切换语言失败："],
  ["components/Settings.js", "关覆盖层 "],
  ["editor/keys.js", "accel 解析不出键名"],
  ["editor/keys.js", "owner=web 却没有 accel —— 没有可断言的规范键"],
  ["editor/keys.js", "」按不动"],
  ["editor/keys.js", "」非按 Shift 敲不出来 ⇒ CM6 查不到这个串（静默失效）"],
  ["editor/keys.js", "不含 cmd —— 阅读态能按、编辑态按不动（分叉）"],
  ["editor/keys.js", "含 ctrl —— 刻意不转发（决策 3 预留）"],
  ["editor/keys.js", "按键转发：keymap 还没绑上就来转发了 —— 表里的动作「"],
  ["editor/keys.js", "键名「"],
  ["editor/main.js", " 字）"],
  ["editor/main.js", " 字，读回 "],
  ["editor/main.js", " 项（含保存键）/ Vim 装配面在"],
  ["editor/main.js", " 项）—— 后端表里的 file.save 没了 / 它的 accel 变了"],
  ["editor/main.js", "CM6 在 / 文本往返逐字相等 / 转发 "],
  ["editor/main.js", "bundle 没加载（window.rmdCM6 不在）——跑 make cm6"],
  ["editor/main.js", "bundle 的导出面不对（EditorView / EditorState / Prec 缺）"],
  ["editor/main.js", "bundle 里没有 `Vim.defineEx`（`:w` 会是静默 no-op，用户以为存了）"],
  ["editor/main.js", "bundle 里没有 `vim`（编辑态 Vim 开关会点了没反应）—— 跑 make cm6"],
  ["editor/main.js", "bundle 里没有 keymap（@codemirror/view 的导出面变了）"],
  ["editor/main.js", "rmd-自证-探针"],
  ["editor/main.js", "临时 EditorView 建不出来："],
  ["editor/main.js", "临时 EditorView 的文本往返不等（写进去 "],
  ["editor/main.js", "没有 document（自证建不出临时容器）"],
  ["editor/main.js", "转发白名单是空的 —— §2.3-4 的派生判据写错了（编辑区里应用键会全部失效）"],
  ["editor/main.js", "转发白名单里没有保存键（共 "],
  ["main.js", " / 区间核对="],
  ["main.js", " / 哨兵 "],
  ["main.js", " 项"],
  ["main.js", " 项，跳过 "],
  ["main.js", "report_measure 失败："],
  ["main.js", "report_status 失败："],
  ["main.js", "⚠️ 注入语言与快照不一致（注入="],
  ["main.js", "⚠️ 菜单未能立即切换语言（menu_updated=false），将在重启后生效"],
  ["main.js", "⛔ open_link 调用失败（多半是 ACL 少了 allow-open-link）："],
  ["main.js", "⛔ 取 Apple Event 打开请求失败（多半是 ACL 少了 allow-take-pending-open）："],
  ["main.js", "⛔ 快捷键自检没过："],
  ["main.js", "⛔ 拿不到快捷键表（多半是 ACL 少了 allow-get-shortcuts）："],
  ["main.js", "⛔ 撤销写授权失败（后端可能还握着它）："],
  ["main.js", "⛔ 树里定位出错："],
  ["main.js", "⛔ 编辑功能自证没过："],
  ["main.js", "⛔ 刷新侧边栏失败："],
  ["main.js", "⛔ 订阅 Apple Event 打开请求失败（多半是 core:event:allow-listen 被拒）："],
  ["main.js", "⛔ 订阅目录变化事件失败（多半是 core:event:allow-listen 被拒）："],
  ["main.js", "⛔ 订阅文件变化事件失败："],
  ["main.js", "⛔ 订阅命令行工具结果失败（多半是 ACL 少了 core:event:allow-listen）："],
  ["main.js", "⛔ 订阅菜单事件失败（多半是 ACL 少了 core:event:allow-listen）："],
  ["main.js", "⛔ 转发白名单有该报的项："],
  ["main.js", "决策条动作抛错："],
  ["main.js", "启动失败："],
  ["main.js", "命中 "],
  ["main.js", "对"],
  ["main.js", "快捷键自检："],
  ["main.js", "按比例"],
  ["main.js", "搜索出错："],
  ["main.js", "搜索浮层打开："],
  ["main.js", "收不到文件变化事件（自动刷新不可用）："],
  ["main.js", "文件名搜索：当前不是目录模式（没有已授权的目录）"],
  ["main.js", "无"],
  ["main.js", "未做"],
  ["main.js", "树读取出错："],
  ["main.js", "正文内查找：还没有已打开的文档（没有可搜的正文）"],
  ["main.js", "没有 Vim 装配面（`make cm6` 跑过吗？）—— Vim 开关会点了没反应，`:w` 也不会注册"],
  ["main.js", "没有已挂载的文档"],
  ["main.js", "精确"],
  ["main.js", "编辑功能自证："],
  ["main.js", "编辑态未起"],
  ["main.js", "自证抛错："],
  ["main.js", "转发白名单 "],
  ["main.js", "转发白名单是空的（应用键在编辑区里会全部失效）"],
  ["main.js", "连回报都失败了："],
  ["main.js", "错"],
  ["main.js", "），以快照为准"],
  ["main.js", "，快照="],
  ["main.js", "｜折线 "],
  ["main.js", "｜来源 "],
  ["main.js", "｜锚点 "],
  ["services/chunked.js", "分片收尾回调出错："],
  ["services/dirsession.js", "目录会话恢复：打开上次的文件失败："],
  ["services/find.js", "范围：渲染后的正文（不含 Markdown 源码标记）"],
  ["services/keymap.js", " 个，一一对应"],
  ["services/keymap.js", " 项 / handler "],
  ["services/keymap.js", "」**没有 handler**（表里有、代码没接）"],
  ["services/keymap.js", "」是 owner=web 却没有 accel —— 它的规范键会静默失效（只剩别名能用）"],
  ["services/keymap.js", "」（来源 "],
  ["services/keymap.js", "代码里接了、表里没有（多半是迁移漏删）："],
  ["services/keymap.js", "快捷键分发：动作「"],
  ["services/keymap.js", "快捷键分发：收到表外的动作 id「"],
  ["services/keymap.js", "快捷键表：动作「"],
  ["services/keymap.js", "表 "],
  ["services/keymap.js", "表里有、没有 handler："],
  ["services/renderstat.js", " · 代码未高亮 {un} / {all} 块（规模限制，内容完整）"],
  ["services/session.js", "unwatch_document 失败："],
  ["services/session.js", "文件监视已停止（授权已改变）"],
  ["services/session.js", "自动刷新不可用："],
  // ⭐ `design/0035`：改名后重启监视失败的那一句（诊断出口，屏幕那行按
  //    `reload.watch-rename-failed` 现翻）
  ["services/session.js", "自动刷新不可用：改名后没能重建监视"],
  ["services/session.js", "让后端放下陈旧监视失败："],
  ["services/tauri.js", "拿不到 window.__TAURI__.event（withGlobalTauri 或 ACL 的问题）"],
  ["services/tauri.js", "拿不到 window.__TAURI__（检查 tauri.conf.json 的 app.withGlobalTauri）"],
  ["services/tauri.js", "翻译错误文案失败："],
  ["services/theme.js", "主题订阅者抛错（已忽略，其余订阅者照常）："],
  ["services/theme.js", "设置没能保存（本次仍然生效，下次启动会回退）："],
];;

const EXEMPT_SET = new Set(EXEMPT.map(function (e) { return e[0] + '\u0000' + e[1]; }));

function isExempt(rel, text) {
  return EXEMPT_SET.has(rel + '\u0000' + text);
}

/** 裸判据：一份源码里**没登记**的中文字面量。 */
function untranslated(rel, src) {
  return scanLiterals(stripComments(src)).filter(function (l) {
    return CJK.test(l.text) && !isExempt(rel, l.text);
  });
}

test('⭐ 裸判据自测：**没登记**的中文必须被抓到（防止有人把范围改窄、闸门照样全绿）', function () {
  const fake = [
    'var el = document.getElementById("x");',
    "el.textContent = '这是一句漏翻的中文';",
  ].join('\n');
  const found = untranslated('components/NoSuchFile.js', fake);
  assert.strictEqual(found.length, 1, '裸判据没抓到漏翻的中文 —— 闸门本身坏了');
  assert.strictEqual(found[0].line, 2);
});

test('裸判据自测：**注释里的**中文不算（注释是文档，⛔ 不是界面文案）', function () {
  const fake = [
    '// 这是注释里的中文',
    '/* 块注释里的中文 */',
    "t('sidebar.tab-files');",
  ].join('\n');
  assert.deepStrictEqual(untranslated('components/NoSuchFile.js', fake), []);
});

test('裸判据自测：白名单命中就放行（诊断出口那条路真的能用）', function () {
  const [rel, text] = EXEMPT[0];
  assert.deepStrictEqual(untranslated(rel, "console.error('" + text + "');"), []);
});

test('⭐ `src/**` 里**没有**未登记的中文字面量（漏翻的自动防线）', function () {
  const bad = [];
  JS_FILES.forEach(function (f) {
    if (f.rel === DICT_FILE) return;        // 字典本身：它就是中文的家
    untranslated(f.rel, f.text).forEach(function (l) {
      bad.push(f.rel + ':' + l.line + ' ' + JSON.stringify(l.text));
    });
  });
  assert.deepStrictEqual(bad, [],
    '这些中文字面量既不在诊断白名单里、也没走 `t()`（切英文时它们不会变）：\n' + bad.join('\n'));
});

test('⭐ 白名单里**每一条都还存在**（防止它烂成一张没人敢动的许可清单）', function () {
  const stale = [];
  const missingFile = [];
  EXEMPT.forEach(function (e) {
    const rel = e[0];
    const text = e[1];
    const f = JS_FILES.find(function (x) { return x.rel === rel; });
    if (!f) { missingFile.push(rel); return; }
    const still = scanLiterals(stripComments(f.text)).some(function (l) { return l.text === text; });
    if (!still) stale.push(rel + ' ' + JSON.stringify(text));
  });
  assert.deepStrictEqual(missingFile, [], '白名单指向的文件不在了：' + missingFile.join(', '));
  assert.deepStrictEqual(stale, [], '白名单里的这些串在源码里已经不存在了，删掉它们：\n' + stale.join('\n'));
});

test('白名单本身是**有内容的**（⛔ 别为了让它变绿而清空）', function () {
  assert.ok(EXEMPT.length >= 20, '白名单只剩 ' + EXEMPT.length + ' 条 —— 诊断出口不该这么少');
});

// ────────────────────────────────────────────────────────────────
// ⑨ ⭐⭐ 侧边栏两个图标的 tooltip ＝ 标签 ＋ 键位（2026-10-22 用户点题）
//
// 用户原话：「最好鼠标放到收放到图标那里，可以展示快捷键。类似 ChatGPT 的客户端一样。」
//
// ⚠️ 这条**只能是源码级**闸门：`src/main.js` 是根脚本，进不了 `require`（同 `sync.test.js`
//    / `vim.test.js` / `dirsession.test.js` 那一族）。它守的三个失效形态**全都不会报错**：
//    ① 忘了在 `setupKeys()` **之后**补一次 ⇒ tooltip 永远没有键位（那一刻表才到手）；
//    ② 忘了挂在 `relabelDynamic()`（`setLang` 的**订阅者**那一档）⇒ 切一次语言键位就消失，
//       而英文界面上其余一切正常（`applyDom` 不做占位符替换，它只会顶回纯标签）；
//    ③ 键位写成字面量或自己另取一份 ⇒ 那是 `INV-SET-01` 的第二种形态：
//       "键位改了、提示还说着旧的"（`keymap.test.js` 的键位字面量那条管另一半）。
// ────────────────────────────────────────────────────────────────

/** 取一个具名函数的**函数体**（`code` 须已剥注释）；找不到或没配平返回 `null`。 */
function fnBody(code, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(code);
  if (!m) return null;
  const open = code.indexOf('{', m.index);
  if (open < 0) return null;
  const close = matchBrace(code, open);
  return close < 0 ? null : code.slice(m.index, close + 1);
}

/**
 * 裸判据：一份 `main.js` 源码里，"tooltip 带键位"这件事**接线对不对**。
 * @returns {string[]} 问题清单（空 = 通过）。
 */
function keyHintProblems(code) {
  const bad = [];
  const body = fnBody(code, 'syncSidebarKeyHints');
  if (!body) {
    bad.push('找不到 `syncSidebarKeyHints()` 的函数体（拼装处没了？）');
    return bad;
  }
  // ① 键位**从后端那张表取**，⛔ 不是字面量
  if (!/accelText\(\s*['"]view\.toggle-sidebar['"]\s*\)/.test(body)) {
    bad.push('`syncSidebarKeyHints()` 没从 `accelText(\'view.toggle-sidebar\')` 取键位');
  }
  // ② 两条 `*-key` 都要用上（少了任何一条，那个图标的提示就不带键）
  ['sidebar.collapse-key', 'sidebar.expand-key'].forEach(function (k) {
    if (body.indexOf("'" + k + "'") < 0) bad.push('`syncSidebarKeyHints()` 没用 `' + k + '`');
  });
  // ③ 表没到手时退成**纯标签**（"宁可少说，不能说错"，同 `openHint`）
  ['sidebar.collapse', 'sidebar.expand'].forEach(function (k) {
    if (body.indexOf("'" + k + "'") < 0) bad.push('`syncSidebarKeyHints()` 少了回落用的裸键 `' + k + '`');
  });

  // ④ 调用点：定义之外至少两处——启动那次 ＋ 换语言那次
  const defM = /function\s+syncSidebarKeyHints\s*\(/.exec(code);
  const defNameIdx = defM.index + defM[0].indexOf('syncSidebarKeyHints');
  const calls = [];
  const callRe = /syncSidebarKeyHints\s*\(/g;
  let m;
  while ((m = callRe.exec(code))) {
    if (m.index !== defNameIdx) calls.push(m.index);
  }
  if (calls.length < 2) {
    bad.push('`syncSidebarKeyHints()` 只在 ' + calls.length + ' 处被调（要 ≥ 2：启动那次 ＋ 换语言那次）');
  }

  // ⑤ 换语言那一次必须真的在 `relabelDynamic()` 体内
  const relabel = fnBody(code, 'relabelDynamic');
  let span = null;
  if (!relabel) {
    bad.push('找不到 `relabelDynamic()` —— 换语言重贴的挂点没了');
  } else {
    const at = code.indexOf(relabel);
    span = [at, at + relabel.length];
    if (relabel.indexOf('syncSidebarKeyHints(') < 0) {
      bad.push('`relabelDynamic()` 里没有调 `syncSidebarKeyHints()` ⇒ 切一次语言，键位就没了');
    }
  }

  // ⑥ 启动那一次必须**在 `await setupKeys()` 之后**（之前表还是空的，等于没调）
  const keysAt = code.indexOf('await setupKeys()');
  if (keysAt < 0) {
    bad.push('找不到 `await setupKeys()` —— 锚点失效，这条闸门什么都没在守');
  } else {
    // 定义在 `relabelDynamic()` 之外的调用点 = 启动那一次（可能不止一处）
    const boot = calls.filter(function (i) {
      return !(span && i >= span[0] && i < span[1]);
    });
    if (!boot.length) {
      bad.push('除了换语言那一处，`syncSidebarKeyHints()` 没有任何启动调用点 ⇒ tooltip 永远不带键位');
    } else if (!boot.every(function (i) { return i > keysAt; })) {
      bad.push('有一处 `syncSidebarKeyHints()` 排在 `await setupKeys()` 之前（那一刻表还是空的）');
    }
  }
  return bad;
}

/** 变异必须**真的改到源码**——⛔ 静默没匹配上会让"没红"与"判据不敏感"长得一模一样。 */
function mutate(src, from, to) {
  const out = src.replace(from, to);
  assert.notStrictEqual(out, src, '⚠️ 变异没改到源码（模式没匹配上）：' + from);
  return out;
}

test('⭐ 裸判据自测：四处变异必须各自让它变红（⛔ 不许有一处恒绿）', function () {
  const real = stripComments(fileText('main.js'));
  assert.deepStrictEqual(keyHintProblems(real), [], '真源码现在就不通过 —— 先修源码，再看这条自测');

  const cases = [
    // ① 换语言那次没挂（本族最阴的一种：界面上一切正常，切一次语言键位就没了）
    //    ⚠️ 2026-10-23（`design/0037`）：`relabelDynamic()` 里紧跟着多了一行
    //    `syncChromeHints();`，所以这里**不能再匹配到那个收尾 `}`**——
    //    锚点收窄成"这一行本身"（`replace` 只动**第一处**，也就是 relabel 那次）。
    ['relabelDynamic 里那次调用被删', real,
      mutate(real, '    syncSidebarKeyHints();\n', '\n')],
    // ② 键位自己写死（= `INV-SET-01` 的原始形态）
    ['键位改成字面量', real,
      mutate(real, "accelText('view.toggle-sidebar')", "'Cmd+B'")],
    // ③ 启动那次挪到表到手之前
    ['启动那次调用挪到 setupKeys 之前', real,
      mutate(real, '    await setupKeys();', '    syncSidebarKeyHints();\n    await setupKeys();')],
    // ④ 少一条带键的文案（那个图标的提示就不带键了）
    ['展开那一条退回裸键', real,
      mutate(real, "['btn-expand', 'sidebar.expand', 'sidebar.expand-key']", "['btn-expand', 'sidebar.expand', 'sidebar.expand']")],
  ];
  cases.forEach(function (c) {
    assert.notStrictEqual(keyHintProblems(c[2]), [], '⚠️ 变异「' + c[0] + '」没让裸判据变红 —— 它不承重');
  });
});

test('⭐⭐ 侧边栏「收起 / 展开」的 tooltip 带键位，且跟着换语言重贴', function () {
  assert.deepStrictEqual(keyHintProblems(stripComments(fileText('main.js'))), [],
    '`src/main.js` 的 tooltip 接线不对（见上一条的判据说明）');
});

