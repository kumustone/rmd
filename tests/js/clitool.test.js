// 「安装 / 卸载命令行工具」结果 → 状态条那几句话（`src/services/clitool.js`，`design/0033`）。
//
// ⭐ 这里守的全是**不报错的失效形态**——程序跑得好好的，只是屏幕上那句话不对：
//
//   ① **键表与字典对不上**：`KEYS` 里写了一个字典没有的键 ⇒ 状态条上是**键名本身**
//      （`status.cli.install.installed`），而那看起来像"排版坏了"。
//   ② **占位符没给齐**：模板里有 `{path}` / `{detail}`，调用方没给 ⇒ 句子缺一块，
//      例如「未安装： 已存在且不是本应用建的链接（）」。
//   ③ ⭐ **合并错了**：把「一条删了、另一条取消」说成一句"什么都没做"
//      （`features/0033` §3 明文禁止），或把未知结果**静默丢掉**——
//      后者更坏：状态条会停在**上一次操作**那句话上，看着像这次压根没发生。
//   ④ **升级/误报**：`cancelled` / `absent` / `not-on-path` 这类**正常结局**被画成红字。
//   ⑤ **嵌套词不翻译**：`shadowed` 那半句里的"别名 / 函数 / 内建"⛔ 不能被提前烤成中文
//      ——否则切语言之后那半句停在旧语言。
//
// 跑法：`make test-js`（= `node --test tests/js/`）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const I = require('../../src/services/i18n.js');

// ⚠️ 这个模块是给浏览器用的经典脚本（IIFE 挂 `window.rmd`），
//    所以拿一个假的 `window` 把它跑起来——⛔ 不是 `require` 一个 CommonJS 模块。
function load() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'services', 'clitool.js'),
    'utf8'
  );
  const win = {};
  new Function('window', src)(win);
  return win.rmd.cliTool;
}

const CT = load();

/** 把 `KEYS` 摊平成一组键名（三层：install/uninstall/verify/kind + uninstallNone）。 */
function allKeys() {
  const out = [CT.KEYS.uninstallNone];
  ['install', 'uninstall', 'verify', 'kind'].forEach(function (group) {
    const table = CT.KEYS[group];
    Object.keys(table).forEach(function (name) { out.push(table[name]); });
  });
  return out;
}

/**
 * 切到某门语言，**当场**渲染。
 *
 * ⚠️ ⛔ 不能写成"先取两个 `t` 再分别用"——`I.t` 是**同一个函数**，
 * 它读的是模块里那个 `current`，所以后切的语言会把先前那句也一起改掉
 * （`tr('zh')` 与 `tr('en')` 拿到的是同一个引用）。这正是本文件要抓的那类错。
 */
function renderIn(lang, lines) {
  I.setLang(lang);
  return CT.render(lines, I.t);
}

const INSTALL_KEYS = ['installed', 'replaced', 'already', 'conflict', 'refused', 'failed', 'cancelled'];
const UNINSTALL_KEYS = ['uninstalled', 'absent', 'not-ours', 'cancelled', 'failed'];
const VERIFY_STATES = ['verified', 'not-on-path', 'shadowed-file', 'shadowed-kind', 'unknown'];

test('键表里的每一条在中英两本字典里都有非空文案', () => {
  // ⚠️ 直接用 `DICT` 查，⛔ 不用 `t()`：`t()` 对缺失键会**静默回落**到 zh 或键名，
  //    那样"英文少一条"这条永远抓不到。
  const keys = allKeys();
  assert.ok(keys.length >= 22, '键表至少 22 条（install 7 ＋ uninstall 5 ＋ none 1 ＋ verify 5 ＋ kind 4）');
  ['zh', 'en'].forEach(function (lang) {
    const d = I.DICT[lang];
    keys.forEach(function (k) {
      assert.strictEqual(typeof d[k], 'string', lang + ' 缺键：' + k);
      assert.ok(d[k].trim().length > 0, lang + ' 的 ' + k + ' 是空白');
    });
  });
});

test('键表里没有重复的键名', () => {
  const keys = allKeys();
  assert.strictEqual(new Set(keys).size, keys.length, '有重复键：' + keys.join(', '));
});

test('install 七种结果各有一句话，且不会被当成"已装好"', () => {
  const seen = new Set();
  INSTALL_KEYS.forEach(function (result) {
    const lines = CT.summarize({
      action: 'install',
      candidates: [{ path: '/home/u/.local/bin/rmd', result: result, detail: '细节' }],
      verify: null,
    });
    assert.strictEqual(lines.length, 1, result + ' 应当只有一行');
    assert.strictEqual(lines[0].key, CT.KEYS.install[result]);
    seen.add(lines[0].key);
  });
  assert.strictEqual(seen.size, INSTALL_KEYS.length);
});

test('install 带 verify 时是两句：先链接、再探测', () => {
  const lines = CT.summarize({
    action: 'install',
    candidates: [{ path: '/home/u/.local/bin/rmd', result: 'installed' }],
    verify: { state: 'verified', kind: 'file', path: '/home/u/.local/bin/rmd' },
  });
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].key, CT.KEYS.install.installed);
  assert.strictEqual(lines[1].key, CT.KEYS.verify.verified);
});

test('verify 五态各有一句话', () => {
  const cases = [
    [{ state: 'verified' }, CT.KEYS.verify.verified],
    [{ state: 'not-on-path' }, CT.KEYS.verify['not-on-path']],
    [{ state: 'shadowed', kind: 'file', path: '/opt/other/rmd' }, CT.KEYS.verify['shadowed-file']],
    [{ state: 'shadowed', kind: 'alias' }, CT.KEYS.verify['shadowed-kind']],
    [{ state: 'unknown' }, CT.KEYS.verify.unknown],
  ];
  cases.forEach(function (c) {
    const lines = CT.summarize({
      action: 'install',
      candidates: [{ path: '/home/u/.local/bin/rmd', result: 'installed' }],
      verify: c[0],
    });
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[1].key, c[1], JSON.stringify(c[0]));
  });
  // ⚠️ 上面五条就是 `VERIFY_STATES` 那五态，一个不少。
  assert.strictEqual(cases.length, VERIFY_STATES.length);
});

test('shadowed 但 kind 叫不出名字 ⇒ 归「未能判定」，⛔ 不硬套成别名', () => {
  // ⚠️ 这条是 `INV-CLI-15` 的同一条精神：不知道它是什么，就不许编一句话说它是什么。
  const lines = CT.summarize({
    action: 'install',
    candidates: [{ path: '/h/.local/bin/rmd', result: 'installed' }],
    verify: { state: 'shadowed', kind: 'sorcery' },
  });
  assert.strictEqual(lines[1].key, CT.KEYS.verify.unknown);
  // 连 `kind` 都没有也一样。
  const noKind = CT.summarize({
    action: 'install',
    candidates: [{ path: '/h/.local/bin/rmd', result: 'installed' }],
    verify: { state: 'shadowed' },
  });
  assert.strictEqual(noKind[1].key, CT.KEYS.verify.unknown);
});

test('四类 kind 在中文与英文里都翻成各自的词', () => {
  const expect = { alias: ['别名', 'alias'], function: ['函数', 'function'], builtin: ['内建命令', 'builtin'], keyword: ['保留字', 'reserved'] };
  Object.keys(expect).forEach(function (kind) {
    const payload = {
      action: 'install',
      candidates: [{ path: '/h/.local/bin/rmd', result: 'installed' }],
      verify: { state: 'shadowed', kind: kind },
    };
    const zhText = renderIn('zh', CT.summarize(payload));
    const enText = renderIn('en', CT.summarize(payload));
    assert.ok(zhText.indexOf(expect[kind][0]) >= 0, 'zh 缺 ' + kind + '：' + zhText);
    assert.ok(enText.indexOf(expect[kind][1]) >= 0, 'en 缺 ' + kind + '：' + enText);
    // ⭐ 英文那一遍**不许**混进中文——嵌套词若被提前烤成中文，它会留在那里。
    assert.ok(!/[㐀-鿿]/.test(enText), '英文输出里混进了汉字：' + enText);
  });
});

test('⭐ 同一份 summarize 结果换语言要能整句重画（判据与文案真的分开了）', () => {
  // ⚠️ 这条钉的是 `main.js` 那条接线的语义：状态条存的是**取值器**，
  //    切语言时拿的是**同一份** `lines`，再调用一次 `render`。
  //    ⇒ 若哪天有人把中文提前烤进 `summarize`，这里会因为两句相同而变红。
  const lines = CT.summarize({
    action: 'install',
    candidates: [{ path: '/h/.local/bin/rmd', result: 'installed' }],
    verify: { state: 'shadowed', kind: 'builtin' },
  });
  const zhText = renderIn('zh', lines);
  const enText = renderIn('en', lines);
  assert.notStrictEqual(zhText, enText);
  assert.ok(!/[㐀-鿿]/.test(enText), enText);
  // 语言切回来，同一份 `lines` 还要原样复原。
  assert.strictEqual(renderIn('zh', lines), zhText);
});

test('uninstall 两个落点都 absent ⇒ 合并成一句，路径都在里面', () => {
  const lines = CT.summarize({
    action: 'uninstall',
    candidates: [
      { path: '/home/u/.local/bin/rmd', result: 'absent' },
      { path: '/usr/local/bin/rmd', result: 'absent' },
    ],
    verify: null,
  });
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].key, CT.KEYS.uninstallNone);
  assert.strictEqual(lines[0].vars.a, '/home/u/.local/bin/rmd');
  assert.strictEqual(lines[0].vars.b, '/usr/local/bin/rmd');
});

test('uninstall 的落点不是恰好两个 ⇒ ⛔ 不硬套那句"都没有"', () => {
  // ⚠️ `INV-CLI-16` 说 uninstall 恒 2 项；形状不对时逐条说，
  //    否则模板里的 `{a}`/`{b}` 会有一个是空的（句子里留个洞）。
  const one = CT.summarize({
    action: 'uninstall',
    candidates: [{ path: '/home/u/.local/bin/rmd', result: 'absent' }],
    verify: null,
  });
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].key, CT.KEYS.uninstall.absent);
  const three = CT.summarize({
    action: 'uninstall',
    candidates: [
      { path: '/a/rmd', result: 'absent' },
      { path: '/b/rmd', result: 'absent' },
      { path: '/c/rmd', result: 'absent' },
    ],
    verify: null,
  });
  assert.strictEqual(three.length, 3);
});

test('⭐ 一条删了、另一条取消 ⇒ 逐条两句，⛔ 不合并成"什么都没做"', () => {
  const lines = CT.summarize({
    action: 'uninstall',
    candidates: [
      { path: '/home/u/.local/bin/rmd', result: 'uninstalled' },
      { path: '/usr/local/bin/rmd', result: 'cancelled' },
    ],
    verify: null,
  });
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].key, CT.KEYS.uninstall.uninstalled);
  assert.strictEqual(lines[1].key, CT.KEYS.uninstall.cancelled);
  // 反过来也一样（顺序跟着载荷走）。
  const rev = CT.summarize({
    action: 'uninstall',
    candidates: [
      { path: '/home/u/.local/bin/rmd', result: 'cancelled' },
      { path: '/usr/local/bin/rmd', result: 'uninstalled' },
    ],
    verify: null,
  });
  assert.strictEqual(rev.length, 2);
});

test('uninstall 五种结果各有一句话', () => {
  UNINSTALL_KEYS.forEach(function (result) {
    const lines = CT.summarize({
      action: 'uninstall',
      // ⚠️ 另一条故意给 `uninstalled`：只要不全是 `absent` 就必须逐条，
      //    否则这一段测的其实是合并那条路。
      candidates: [
        { path: '/home/u/.local/bin/rmd', result: result, detail: '细节' },
        { path: '/usr/local/bin/rmd', result: 'uninstalled' },
      ],
      verify: null,
    });
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].key, CT.KEYS.uninstall[result]);
  });
});

test('uninstall 的结果里不会冒出 verify（它恒为 null）', () => {
  const lines = CT.summarize({
    action: 'uninstall',
    candidates: [{ path: '/home/u/.local/bin/rmd', result: 'uninstalled' }],
    verify: null,
  });
  assert.strictEqual(lines.length, 1);
});

test('⭐ 认不出的结果不许静默丢：退回"失败"并把原值放进 detail', () => {
  const lines = CT.summarize({
    action: 'install',
    candidates: [{ path: '/h/.local/bin/rmd', result: 'cancelled-by-os' }],
    verify: null,
  });
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].key, CT.KEYS.install.failed);
  assert.strictEqual(lines[0].vars.detail, 'cancelled-by-os');
});

test('install 的 conflict / refused / failed 把后端的 detail 原样带出来', () => {
  ['conflict', 'refused', 'failed'].forEach(function (result) {
    const lines = CT.summarize({
      action: 'install',
      candidates: [{ path: '/h/.local/bin/rmd', result: result, detail: '指向 /tmp/foo' }],
      verify: null,
    });
    assert.strictEqual(lines[0].vars.detail, '指向 /tmp/foo', result);
  });
});

test('每个模板的占位符都由 summarize 给齐（中英各一遍）', () => {
  // ⚠️ 用 `i18n.js` 自己的记账（`missingVars`）判——⛔ 不用肉眼比对模板。
  //    它记的是"模板里有、调用方没给"，正是"句子缺一块"的那种缺陷。
  const payloads = [];
  INSTALL_KEYS.forEach(function (result) {
    payloads.push({
      action: 'install',
      candidates: [{ path: '/h/.local/bin/rmd', result: result, detail: '细节' }],
      verify: null,
    });
  });
  ['verified', 'not-on-path', 'unknown'].forEach(function (state) {
    payloads.push({
      action: 'install',
      candidates: [{ path: '/h/.local/bin/rmd', result: 'installed' }],
      verify: { state: state },
    });
  });
  payloads.push({
    action: 'install',
    candidates: [{ path: '/h/.local/bin/rmd', result: 'installed' }],
    verify: { state: 'shadowed', kind: 'file', path: '/opt/other/rmd' },
  });
  ['alias', 'function', 'builtin', 'keyword'].forEach(function (kind) {
    payloads.push({
      action: 'install',
      candidates: [{ path: '/h/.local/bin/rmd', result: 'installed' }],
      verify: { state: 'shadowed', kind: kind },
    });
  });
  UNINSTALL_KEYS.forEach(function (result) {
    payloads.push({
      action: 'uninstall',
      candidates: [
        { path: '/home/u/.local/bin/rmd', result: result, detail: '细节' },
        { path: '/usr/local/bin/rmd', result: 'uninstalled' },
      ],
      verify: null,
    });
  });
  payloads.push({
    action: 'uninstall',
    candidates: [
      { path: '/home/u/.local/bin/rmd', result: 'absent' },
      { path: '/usr/local/bin/rmd', result: 'absent' },
    ],
    verify: null,
  });

  ['zh', 'en'].forEach(function (lang) {
    const before = I.missingVars().length;
    payloads.forEach(function (p) {
      const text = renderIn(lang, CT.summarize(p));
      assert.ok(text.length > 0, lang + ' 渲染出空串：' + JSON.stringify(p));
      // ⭐ 状态条上出现键名/占位符残留，说明这张表与字典对不上。
      assert.ok(text.indexOf('{') < 0, lang + ' 句子里有没被替换的占位符：' + text);
      assert.ok(text.indexOf('status.cli.') < 0, lang + ' 句子里有裸键名：' + text);
    });
    assert.deepStrictEqual(
      I.missingVars().slice(before), [],
      lang + ' 有模板占位符没给：' + I.missingVars().slice(before).join(', ')
    );
  });
});

test('not-on-path 的目录从链接路径现算，并给出可复制的一行 export', () => {
  const lines = CT.summarize({
    action: 'install',
    candidates: [{ path: '/home/u/.local/bin/rmd', result: 'installed' }],
    verify: { state: 'not-on-path' },
  });
  assert.strictEqual(lines[1].vars.dir, '/home/u/.local/bin');
  const text = renderIn('zh', lines);
  assert.ok(text.indexOf('export PATH="/home/u/.local/bin:$PATH"') >= 0, text);
  // ⚠️ 两句写进哪个文件都必须点到（应用侧拿不到 `$SHELL`，见设计决定）。
  assert.ok(text.indexOf('~/.zshrc') >= 0, text);
  assert.ok(text.indexOf('~/.bash_profile') >= 0, text);
  // ⛔ 除 `verified` 之外任何一句都不许说"能敲/可以用"（`INV-CLI-06`）。
  assert.ok(text.indexOf('现在能敲') < 0, text);
});

test('isError：只有真出事的那些才报红', () => {
  const mk = function (action, result) {
    return { action: action, candidates: [{ path: '/h/.local/bin/rmd', result: result }], verify: null };
  };
  ['conflict', 'refused', 'failed'].forEach(function (r) {
    assert.strictEqual(CT.isError(mk('install', r)), true, 'install ' + r);
  });
  ['installed', 'replaced', 'already', 'cancelled'].forEach(function (r) {
    assert.strictEqual(CT.isError(mk('install', r)), false, 'install ' + r);
  });
  ['not-ours', 'failed'].forEach(function (r) {
    assert.strictEqual(CT.isError(mk('uninstall', r)), true, 'uninstall ' + r);
  });
  ['uninstalled', 'absent', 'cancelled'].forEach(function (r) {
    assert.strictEqual(CT.isError(mk('uninstall', r)), false, 'uninstall ' + r);
  });
});

test('isError：verify 的任何一态都不把状态条染红', () => {
  // ⚠️ `not-on-path` / `shadowed` 是**如实告知**，不是我们做错了什么（`INV-CLI-06`）。
  ['verified', 'not-on-path', 'shadowed', 'unknown'].forEach(function (state) {
    assert.strictEqual(CT.isError({
      action: 'install',
      candidates: [{ path: '/h/.local/bin/rmd', result: 'installed' }],
      verify: { state: state, kind: 'alias' },
    }), false, state);
  });
});

test('空载荷 / 畸形载荷不抛，也不渲染出空白', () => {
  [undefined, null, {}, { action: 'install' }, { action: 'uninstall' }].forEach(function (p) {
    const lines = CT.summarize(p);
    assert.ok(Array.isArray(lines));
    // ⚠️ 没有 candidates 就什么都不说——⛔ 但**不许抛**（事件载荷来自后端，
    //    形状错了也不该把前端的监听器弄挂）。
    assert.strictEqual(lines.length, 0, JSON.stringify(p));
    assert.strictEqual(renderIn('zh', lines), '');
  });
});

test('render 不传字典时回落成键名（而不是 `undefined`）', () => {
  const lines = CT.summarize({
    action: 'install',
    candidates: [{ path: '/h/.local/bin/rmd', result: 'installed' }],
    verify: null,
  });
  assert.strictEqual(CT.render(lines), CT.KEYS.install.installed);
});

test('多句之间用可见的分隔符连起来（⛔ 不粘成一句）', () => {
  const text = renderIn('zh', CT.summarize({
    action: 'install',
    candidates: [{ path: '/h/.local/bin/rmd', result: 'installed' }],
    verify: { state: 'verified' },
  }));
  assert.ok(text.indexOf(' · ') > 0, text);
});

test('index.html 里 services/clitool.js 排在根 main.js 之前', () => {
  // ⚠️ 与 `keymap.test.js` 那条通用加载顺序闸门同族，但**这一条是专门盯着它的**：
  //    `main.js` 在加载期就取 `window.rmd.cliTool`，顺序反了 ⇒ 菜单点了没反应，
  //    启动路径上一个症状都没有（`0009` 实测过的形态）。
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
  const mine = html.indexOf('services/clitool.js');
  const root = html.indexOf('<script src="main.js">');
  assert.ok(mine >= 0, 'index.html 里没有 services/clitool.js');
  assert.ok(root >= 0, 'index.html 里没有根 main.js');
  assert.ok(mine < root, 'services/clitool.js 必须排在 main.js 之前');
});
