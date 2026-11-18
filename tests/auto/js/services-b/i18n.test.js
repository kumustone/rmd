// i18n 的自动化用例（`tests/auto/js/services-b/`）。
//
// ⚠️ 加载方式与 `tests/auto/js/smoke/framework.test.js` 一致：读源码 →
//    `new Function('window', src)(win)`，⛔ 不 `require` 产品文件。
// ⭐ 每条用例都新建一份模块实例：i18n 内部有“当前语言 / 缺失键”状态，
//    共用实例会让前面的用例污染后面（同名缺键只记一次这类断言会假绿）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadI18n(extra) {
  const win = Object.assign({}, extra || {});
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'i18n.js'), 'utf8');
  new Function('window', src)(win);
  return { win: win, I: win.rmd.i18n };
}

/** 模板里的占位符名字（去重、保持出现顺序）。 */
function placeholders(tpl) {
  const out = [];
  for (const m of tpl.matchAll(/\{(\w+)\}/g)) {
    if (out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}

test('字典只有 zh / en 两本', () => {
  const { I } = loadI18n();
  assert.deepStrictEqual(Object.keys(I.DICT).sort(), ['en', 'zh']);
});

test('两本字典的键集合逐字相等', () => {
  const { I } = loadI18n();
  const zh = Object.keys(I.DICT.zh).sort();
  const en = Object.keys(I.DICT.en).sort();
  assert.deepStrictEqual(en, zh);
  assert.ok(zh.length > 100, '字典键数异常少：' + zh.length);
});

test('每个键在中英两本里的占位符集合相等', () => {
  const { I } = loadI18n();
  for (const key of Object.keys(I.DICT.zh)) {
    const a = placeholders(I.DICT.zh[key]).sort();
    const b = placeholders(I.DICT.en[key] || '').sort();
    assert.deepStrictEqual(b, a, '占位符不一致：' + key);
  }
});

test('两本字典都没有空文案', () => {
  const { I } = loadI18n();
  for (const lang of ['zh', 'en']) {
    for (const key of Object.keys(I.DICT[lang])) {
      assert.strictEqual(typeof I.DICT[lang][key], 'string', key + ' 不是字符串');
      assert.notStrictEqual(I.DICT[lang][key], '', lang + ' 的 ' + key + ' 是空串');
    }
  }
});

test('默认语言是 zh，已知键取中文', () => {
  const { I } = loadI18n();
  assert.strictEqual(I.lang(), 'zh');
  assert.strictEqual(I.t('theme.dark'), '深色');
});

test('setLang(en) 之后取英文', () => {
  const { I } = loadI18n();
  I.setLang('en');
  assert.strictEqual(I.lang(), 'en');
  assert.strictEqual(I.t('theme.dark'), 'Dark');
});

test('未知语言一律归一成 zh', () => {
  const { I } = loadI18n();
  I.setLang('fr');
  assert.strictEqual(I.lang(), 'zh');
  assert.strictEqual(I.t('theme.dark'), '深色');
});

test('en / EN / en-US 都归一成 en', () => {
  const { I } = loadI18n();
  assert.strictEqual(I.normalizeLang('en'), 'en');
  assert.strictEqual(I.normalizeLang('EN'), 'en');
  assert.strictEqual(I.normalizeLang('en-US'), 'en');
  assert.strictEqual(I.normalizeLang(' zh-CN '), 'zh');
});

test('初始语言来自注入的 __rmdLang，而不是 navigator', () => {
  const { I } = loadI18n({ __rmdLang: 'en-GB' });
  assert.strictEqual(I.lang(), 'en');
  assert.strictEqual(I.t('theme.dark'), 'Dark');
});

test('未知键原样返回并记入缺失列表', () => {
  const { I } = loadI18n();
  assert.strictEqual(I.t('no.such.key'), 'no.such.key');
  assert.deepStrictEqual(I.missing(), ['no.such.key']);
});

test('空键返回可识别的标记而不是空串', () => {
  const { I } = loadI18n();
  assert.strictEqual(I.t(''), '(i18n: empty key)');
  assert.strictEqual(I.t(null), '(i18n: empty key)');
  assert.ok(I.missing().indexOf('') >= 0);
});

test('missing() 去重且返回的是副本', () => {
  const { I } = loadI18n();
  I.t('x.unknown');
  I.t('x.unknown');
  assert.deepStrictEqual(I.missing(), ['x.unknown']);
  const copy = I.missing();
  copy.push('injected');
  assert.deepStrictEqual(I.missing(), ['x.unknown']);
});

test('插值替换模板里的全部占位符', () => {
  const { I } = loadI18n();
  assert.strictEqual(
    I.t('doclist.truncated-nokey', { shown: 3, total: 10 }),
    '已显示 3 / 10 条'
  );
});

test('英文模板同样走插值', () => {
  const { I } = loadI18n();
  I.setLang('en');
  assert.strictEqual(
    I.t('doclist.truncated-nokey', { shown: 3, total: 10 }),
    'Showing 3 of 10'
  );
});

test('缺参数时替换成空串并记录 key:param', () => {
  const { I } = loadI18n();
  const s = I.t('doclist.truncated-nokey', { shown: 3 });
  assert.ok(s.indexOf('{') < 0, '模板里还残留占位符：' + s);
  assert.ok(I.missingVars().indexOf('doclist.truncated-nokey:total') >= 0);
});

test('参数为 null / undefined 视为缺失', () => {
  const { I } = loadI18n();
  const s = I.t('doclist.truncated-nokey', { shown: null, total: undefined });
  assert.ok(s.indexOf('{') < 0, s);
  assert.ok(I.missingVars().indexOf('doclist.truncated-nokey:shown') >= 0);
  assert.ok(I.missingVars().indexOf('doclist.truncated-nokey:total') >= 0);
});

test('参数为 0 / false 时照常替换，不被当成缺失', () => {
  const { I } = loadI18n();
  assert.strictEqual(I.t('sidebar.unauth-dir', { dir: 0 }), '所在目录：0');
  assert.strictEqual(I.t('sidebar.unauth-dir', { dir: false }), '所在目录：false');
  assert.deepStrictEqual(I.missingVars(), []);
});

test('当前语言缺键时回落到中文，并记下该键', () => {
  const { I } = loadI18n();
  delete I.DICT.en['theme.dark'];
  I.setLang('en');
  assert.strictEqual(I.t('theme.dark'), '深色');
  assert.ok(I.missing().indexOf('theme.dark') >= 0);
});

test('setLang 把 <html lang> 写成 zh-CN / en', () => {
  const seen = [];
  const document = {
    documentElement: {
      setAttribute: function (k, v) { seen.push([k, v]); },
    },
    querySelectorAll: function () { return []; },
  };
  const { I } = loadI18n({ document: document });
  I.setLang('en');
  I.setLang('fr');
  assert.deepStrictEqual(seen, [['lang', 'en'], ['lang', 'zh-CN']]);
});

test('setLang 通知订阅者，退订后不再收到', () => {
  const { I } = loadI18n();
  const got = [];
  const off = I.subscribe(function (lang) { got.push(lang); });
  I.setLang('en');
  I.setLang('zh');
  off();
  I.setLang('en');
  assert.deepStrictEqual(got, ['en', 'zh']);
});

test('一个订阅者抛错不挡住其余订阅者', () => {
  const { I } = loadI18n();
  const oldError = console.error;
  console.error = function () {};
  try {
    const got = [];
    I.subscribe(function () { throw new Error('boom'); });
    I.subscribe(function (lang) { got.push(lang); });
    I.setLang('en');
    assert.deepStrictEqual(got, ['en']);
  } finally {
    console.error = oldError;
  }
});

test('applyDom 重贴文本与属性并返回改动数', () => {
  const textNode = {
    textContent: '旧文案',
    getAttribute: function (k) { return k === 'data-i18n' ? 'theme.dark' : null; },
  };
  const titleNode = {
    _attrs: { 'data-i18n-title': 'theme.dark', title: '旧标题' },
    getAttribute: function (k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
    setAttribute: function (k, v) { this._attrs[k] = v; },
  };
  const root = {
    querySelectorAll: function (sel) {
      if (sel === '[data-i18n]') return [textNode];
      if (sel === '[data-i18n-title]') return [titleNode];
      return [];
    },
  };
  const { I } = loadI18n();
  assert.strictEqual(I.applyDom(root), 2);
  assert.strictEqual(textNode.textContent, '深色');
  assert.strictEqual(titleNode._attrs.title, '深色');
});

test('applyDom 幂等：内容已是译文时返回 0', () => {
  const node = {
    textContent: '深色',
    getAttribute: function (k) { return k === 'data-i18n' ? 'theme.dark' : null; },
  };
  const root = {
    querySelectorAll: function (sel) { return sel === '[data-i18n]' ? [node] : []; },
  };
  const { I } = loadI18n();
  assert.strictEqual(I.applyDom(root), 0);
});

test('applyDom 遇到没有 querySelectorAll 的根返回 0', () => {
  const { I } = loadI18n();
  assert.strictEqual(I.applyDom({}), 0);
  assert.strictEqual(I.applyDom(null), 0); // 缺省根 = document（不存在）⇒ 0
});

test('applyDom 跳过没有 data-i18n 键的节点', () => {
  const node = {
    textContent: '原样',
    getAttribute: function () { return ''; },
  };
  const root = {
    querySelectorAll: function (sel) { return sel === '[data-i18n]' ? [node] : []; },
  };
  const { I } = loadI18n();
  assert.strictEqual(I.applyDom(root), 0);
  assert.strictEqual(node.textContent, '原样');
});

test('setLang 之后 applyDom 贴成新语言', () => {
  const node = {
    textContent: '深色',
    getAttribute: function (k) { return k === 'data-i18n' ? 'theme.dark' : null; },
  };
  const document = {
    documentElement: { setAttribute: function () {} },
    querySelectorAll: function (sel) { return sel === '[data-i18n]' ? [node] : []; },
  };
  const { I } = loadI18n({ document: document });
  I.setLang('en');
  assert.strictEqual(node.textContent, 'Dark');
});

test('has() 区分两本字典，未知语言按 zh 查', () => {
  const { I } = loadI18n();
  assert.strictEqual(I.has('theme.dark'), true);
  assert.strictEqual(I.has('does.not.exist'), false);
  assert.strictEqual(I.has('theme.dark', 'en'), true);
  assert.strictEqual(I.has('theme.dark', 'fr'), true);
  delete I.DICT.en['theme.dark'];
  assert.strictEqual(I.has('theme.dark', 'en'), false);
  assert.strictEqual(I.has('theme.dark', 'zh'), true);
});

test('所有键在两种语言下都能取到非空字符串', () => {
  const { I } = loadI18n();
  for (const lang of ['zh', 'en']) {
    I.setLang(lang);
    for (const key of Object.keys(I.DICT[lang])) {
      const vars = {};
      for (const name of placeholders(I.DICT[lang][key])) vars[name] = 'X';
      const s = I.t(key, vars);
      assert.strictEqual(typeof s, 'string', lang + '/' + key);
      assert.ok(s.length > 0, lang + '/' + key + ' 取到了空串');
    }
  }
});

test('所有模板的占位符填齐后不残留花括号', () => {
  const { I } = loadI18n();
  for (const lang of ['zh', 'en']) {
    I.setLang(lang);
    for (const key of Object.keys(I.DICT[lang])) {
      const vars = {};
      for (const name of placeholders(I.DICT[lang][key])) vars[name] = 'X';
      const s = I.t(key, vars);
      assert.ok(s.indexOf('{') < 0 && s.indexOf('}') < 0, lang + '/' + key + '：' + s);
    }
  }
});

test('missingVars() 去重且返回的是副本', () => {
  const { I } = loadI18n();
  I.t('doclist.truncated-nokey', {});
  I.t('doclist.truncated-nokey', {});
  const got = I.missingVars();
  assert.deepStrictEqual(got, [
    'doclist.truncated-nokey:shown',
    'doclist.truncated-nokey:total',
  ]);
  got.push('injected');
  assert.strictEqual(I.missingVars().length, 2);
});
