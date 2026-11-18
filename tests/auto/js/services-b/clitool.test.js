// clitool 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：结果取值 → 字典键的唯一映射（含未知取值不静默丢）、安装后四态探测、
// 卸载的唯合并句、报红判据，以及 render 的“当场翻译”（嵌套 kind 词也要跟着语言走）。
// ⭐ 与 `src/services/i18n.js` 的 22 条 `status.cli.*` 键逐格比对，⛔ 不另抄一份文案。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load() {
  const win = {};
  for (const rel of ['src/services/i18n.js', 'src/services/clitool.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    new Function('window', src)(win);
  }
  return { I: win.rmd.i18n, C: win.rmd.cliTool };
}

const { I, C } = load();

function leafKeys(obj) {
  const out = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') out.push(v);
    else out.push.apply(out, leafKeys(v));
  }
  return out;
}

// ── 键表一致性 ───────────────────────────────────────────────────

test('KEYS 恰好 22 条，与字典里 status.cli.* 的键集合逐格相等', () => {
  const leaves = leafKeys(C.KEYS);
  assert.strictEqual(leaves.length, 22);
  assert.strictEqual(new Set(leaves).size, 22, 'KEYS 里有重复键');
  const inDict = Object.keys(I.DICT.zh).filter(function (k) {
    return k.indexOf('status.cli.') === 0;
  }).sort();
  assert.deepStrictEqual(leaves.slice().sort(), inDict);
});

test('KEYS 的每一条在中英两本字典里都能取到', () => {
  for (const key of leafKeys(C.KEYS)) {
    assert.strictEqual(I.has(key, 'zh'), true, 'zh 缺 ' + key);
    assert.strictEqual(I.has(key, 'en'), true, 'en 缺 ' + key);
  }
});

// ── summarize：安装 ──────────────────────────────────────────────

test('summarize（install）：已建立链接 → 对应键 + path', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [{ path: '/usr/local/bin/rmd', result: 'installed' }],
  });
  assert.deepStrictEqual(lines, [{
    key: 'status.cli.install.installed',
    vars: { path: '/usr/local/bin/rmd' },
  }]);
});

test('summarize（install）：认不出的结果退回“失败”，并把原值放进 detail', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [{ path: '/x', result: 'brand-new' }],
  });
  assert.deepStrictEqual(lines, [{
    key: 'status.cli.install.failed',
    vars: { path: '/x', detail: 'brand-new' },
  }]);
});

test('summarize（install）：结果为空串时 detail 记 “?”（⛔ 不显示空白）', () => {
  const lines = C.summarize({ action: 'install', candidates: [{ path: '/x', result: '' }] });
  assert.deepStrictEqual(lines[0].vars, { path: '/x', detail: '?' });
});

test('summarize（install）：已知结果带 detail 时保留 detail', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [{ path: '/x', result: 'conflict', detail: '不是本应用建的' }],
  });
  assert.deepStrictEqual(lines[0], {
    key: 'status.cli.install.conflict',
    vars: { path: '/x', detail: '不是本应用建的' },
  });
});

test('summarize（install）：detail 缺失时不塞空字段', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [{ path: '/x', result: 'conflict' }],
  });
  assert.deepStrictEqual(lines[0].vars, { path: '/x' });
});

test('summarize（install）：verify 那一句接在候选行之后', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [{ path: '/x', result: 'installed' }],
    verify: { state: 'verified' },
  });
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines[1], { key: 'status.cli.verify.verified', vars: {} });
});

test('summarize（install）：action 缺失或看不懂时按 install 渲染', () => {
  const a = C.summarize({ candidates: [{ path: '/x', result: 'installed' }] });
  assert.strictEqual(a[0].key, 'status.cli.install.installed');
  const b = C.summarize({ action: 'bogus', candidates: [{ path: '/x', result: 'failed' }] });
  assert.strictEqual(b[0].key, 'status.cli.install.failed');
});

// ── summarize：verify 四态 ───────────────────────────────────────

test('verify not-on-path：目录从链接路径现算', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [{ path: '/usr/local/bin/rmd', result: 'installed' }],
    verify: { state: 'not-on-path' },
  });
  assert.deepStrictEqual(lines[1], {
    key: 'status.cli.verify.not-on-path',
    vars: { dir: '/usr/local/bin', path: '/usr/local/bin/rmd' },
  });
});

test('verify not-on-path：链接在根目录或没有斜杠时退回整串当目录', () => {
  const a = C.summarize({
    action: 'install', candidates: [{ path: '/rmd', result: 'installed' }],
    verify: { state: 'not-on-path' },
  });
  assert.deepStrictEqual(a[1].vars, { dir: '/rmd', path: '/rmd' });
  const b = C.summarize({
    action: 'install', candidates: [{ path: 'rmd', result: 'installed' }],
    verify: { state: 'not-on-path' },
  });
  assert.deepStrictEqual(b[1].vars, { dir: 'rmd', path: 'rmd' });
});

test('verify shadowed-file：如实给出挡住它的文件路径', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [{ path: '/link/rmd', result: 'installed' }],
    verify: { state: 'shadowed', kind: 'file', path: '/usr/bin/rmd' },
  });
  assert.deepStrictEqual(lines[1], {
    key: 'status.cli.verify.shadowed-file',
    vars: { path: '/usr/bin/rmd' },
  });
});

test('verify shadowed-kind：kind 词以嵌套键形式留给 render 翻译', () => {
  for (const kind of ['alias', 'function', 'builtin', 'keyword']) {
    const lines = C.summarize({
      action: 'install',
      candidates: [{ path: '/x', result: 'installed' }],
      verify: { state: 'shadowed', kind: kind },
    });
    assert.deepStrictEqual(lines[1], {
      key: 'status.cli.verify.shadowed-kind',
      vars: { kind: { k: C.KEYS.kind[kind] } },
    }, kind);
  }
});

test('verify shadowed-kind：叫不出名字的 kind 归“未能判定”，⛔ 不硬套别名', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [{ path: '/x', result: 'installed' }],
    verify: { state: 'shadowed', kind: 'brand-new' },
  });
  assert.deepStrictEqual(lines[1], { key: 'status.cli.verify.unknown', vars: {} });
});

test('verify 未知 state / 缺失 state 都归“未能判定”', () => {
  const a = C.summarize({
    action: 'install', candidates: [{ path: '/x', result: 'installed' }],
    verify: { state: 'nonsense' },
  });
  assert.deepStrictEqual(a[1], { key: 'status.cli.verify.unknown', vars: {} });
  const b = C.summarize({
    action: 'install', candidates: [{ path: '/x', result: 'installed' }],
    verify: {},
  });
  assert.deepStrictEqual(b[1], { key: 'status.cli.verify.unknown', vars: {} });
});

test('verify 为 null 时不追加那一句', () => {
  const lines = C.summarize({
    action: 'install', candidates: [{ path: '/x', result: 'installed' }], verify: null,
  });
  assert.strictEqual(lines.length, 1);
});

// ── summarize：卸载 ──────────────────────────────────────────────

test('summarize（uninstall）：两个落点都 absent 时合并成唯一一句', () => {
  const lines = C.summarize({
    action: 'uninstall',
    candidates: [
      { path: '/usr/local/bin/rmd', result: 'absent' },
      { path: '/usr/bin/rmd', result: 'absent' },
    ],
  });
  assert.deepStrictEqual(lines, [{
    key: 'status.cli.uninstall.none',
    vars: { a: '/usr/local/bin/rmd', b: '/usr/bin/rmd' },
  }]);
});

test('summarize（uninstall）：只要有一条不是 absent 就逐条说', () => {
  const lines = C.summarize({
    action: 'uninstall',
    candidates: [
      { path: '/a/rmd', result: 'absent' },
      { path: '/b/rmd', result: 'uninstalled' },
    ],
  });
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].key, 'status.cli.uninstall.absent');
  assert.strictEqual(lines[1].key, 'status.cli.uninstall.uninstalled');
});

test('summarize（uninstall）：落点数不是恰好两个时不套合并模板', () => {
  const lines = C.summarize({
    action: 'uninstall',
    candidates: [
      { path: '/a/rmd', result: 'absent' },
      { path: '/b/rmd', result: 'absent' },
      { path: '/c/rmd', result: 'absent' },
    ],
  });
  assert.strictEqual(lines.length, 3);
  assert.ok(lines.every(function (l) { return l.key === 'status.cli.uninstall.absent'; }));
});

test('summarize（uninstall）：未知结果退回“删除失败”并带上原值', () => {
  const lines = C.summarize({
    action: 'uninstall',
    candidates: [{ path: '/x', result: 'brand-new' }],
  });
  assert.deepStrictEqual(lines, [{
    key: 'status.cli.uninstall.failed',
    vars: { path: '/x', detail: 'brand-new' },
  }]);
});

test('summarize：candidates 缺失 / 非数组时退回空数组，不抛', () => {
  assert.deepStrictEqual(C.summarize({ action: 'install' }), []);
  assert.deepStrictEqual(C.summarize({ action: 'uninstall', candidates: 'x' }), []);
  assert.deepStrictEqual(C.summarize(null), []);
});

// ── render ───────────────────────────────────────────────────────

test('render：用注入的翻译函数逐行翻译，以 “ · ” 连接', () => {
  const lines = [
    { key: 'k1', vars: { path: '/a' } },
    { key: 'k2', vars: {} },
  ];
  const text = C.render(lines, function (k, vars) { return k + ':' + (vars.path || ''); });
  assert.strictEqual(text, 'k1:/a · k2:');
});

test('render：嵌套 kind 键在被调用那一刻翻译，外层拿到的是译文', () => {
  const seen = [];
  const text = C.render([
    { key: 'outer', vars: { kind: { k: 'status.cli.kind.alias' } } },
  ], function (k, vars) {
    seen.push([k, vars]);
    if (k === 'status.cli.kind.alias') return '别名';
    return 'K:' + vars.kind;
  });
  assert.strictEqual(text, 'K:别名');
  assert.deepStrictEqual(seen.map(function (x) { return x[0]; }), ['status.cli.kind.alias', 'outer']);
});

test('render：没有翻译函数时退回键名，并以 “ · ” 连接', () => {
  assert.strictEqual(C.render([{ key: 'a' }, { key: 'b' }]), 'a · b');
});

test('render：翻译成空串的行被丢掉，不留多余分隔符', () => {
  const text = C.render([{ key: 'drop' }, { key: 'keep' }, { key: 'drop' }], function (k) {
    return k === 'keep' ? '留住' : '';
  });
  assert.strictEqual(text, '留住');
});

test('render：非数组 / null / undefined 返回空串', () => {
  assert.strictEqual(C.render(null), '');
  assert.strictEqual(C.render(undefined), '');
  assert.strictEqual(C.render('x'), '');
});

test('render：非对象的占位值原样传给翻译函数（0 / false 不被吞）', () => {
  const seen = [];
  C.render([{ key: 'k', vars: { zero: 0, no: false, path: '/a' } }], function (k, vars) {
    seen.push(vars);
    return 'x';
  });
  assert.deepStrictEqual(seen, [{ zero: 0, no: false, path: '/a' }]);
});

test('render（真字典）：安装成功那一句逐字对应中文文案', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [{ path: '/usr/local/bin/rmd', result: 'installed' }],
  });
  assert.strictEqual(
    C.render(lines, I.t),
    '已建立链接：/usr/local/bin/rmd（指向当前应用，换新版 .app 后它跟着变）'
  );
});

test('render（真字典）：切到英文后嵌套的 kind 词也一起变', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [{ path: '/x', result: 'installed' }],
    verify: { state: 'shadowed', kind: 'alias' },
  });
  I.setLang('zh');
  try {
    assert.ok(C.render(lines, I.t).indexOf('别名') >= 0);
    I.setLang('en');
    const en = C.render(lines, I.t);
    assert.ok(en.indexOf('alias') >= 0, en);
    assert.ok(en.indexOf('别名') < 0, en);
  } finally {
    I.setLang('zh');
  }
});

// ── isError ──────────────────────────────────────────────────────

test('isError（install）：conflict / refused / failed 报红', () => {
  for (const result of ['conflict', 'refused', 'failed']) {
    assert.strictEqual(
      C.isError({ action: 'install', candidates: [{ result: result }] }),
      true, result
    );
  }
});

test('isError（install）：installed / replaced / already / cancelled 不报红', () => {
  for (const result of ['installed', 'replaced', 'already', 'cancelled']) {
    assert.strictEqual(
      C.isError({ action: 'install', candidates: [{ result: result }] }),
      false, result
    );
  }
});

test('isError（uninstall）：not-ours / failed 报红，absent / cancelled 不报红', () => {
  for (const result of ['not-ours', 'failed']) {
    assert.strictEqual(
      C.isError({ action: 'uninstall', candidates: [{ result: result }] }),
      true, result
    );
  }
  for (const result of ['uninstalled', 'absent', 'cancelled']) {
    assert.strictEqual(
      C.isError({ action: 'uninstall', candidates: [{ result: result }] }),
      false, result
    );
  }
});

test('isError：action 缺失 / 未知时按 install 判；没有候选时不报红', () => {
  assert.strictEqual(C.isError({ candidates: [{ result: 'failed' }] }), true);
  assert.strictEqual(C.isError({ action: 'bogus', candidates: [{ result: 'not-ours' }] }), false);
  assert.strictEqual(C.isError({ action: 'install' }), false);
  assert.strictEqual(C.isError(null), false);
});
