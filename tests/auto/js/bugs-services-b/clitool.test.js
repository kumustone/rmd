// clitool 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：结果 → 字典键的逐格映射、未知结果不静默丢、卸载的"唯一允许合并"、
// verify 四态与"目录从链接路径现算"、嵌套词条的延迟翻译、报红判据。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'clitool.js'), 'utf8');

function loadCli() {
  const win = {};
  new Function('window', SRC)(win);
  return win.rmd.cliTool;
}

const C = loadCli();

function cand(result, p, detail) {
  const c = { path: p, result: result };
  if (detail !== undefined) c.detail = detail;
  return c;
}

// ── 键表是线上契约的一半 ───────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('install 七种结果各配一句，⛔ 不多不少', () => {
  assert.deepStrictEqual(C.KEYS.install, {
    installed: 'status.cli.install.installed',
    replaced: 'status.cli.install.replaced',
    already: 'status.cli.install.already',
    conflict: 'status.cli.install.conflict',
    refused: 'status.cli.install.refused',
    failed: 'status.cli.install.failed',
    cancelled: 'status.cli.install.cancelled',
  });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('uninstall 五种结果各配一句', () => {
  assert.deepStrictEqual(C.KEYS.uninstall, {
    uninstalled: 'status.cli.uninstall.uninstalled',
    absent: 'status.cli.uninstall.absent',
    'not-ours': 'status.cli.uninstall.not-ours',
    cancelled: 'status.cli.uninstall.cancelled',
    failed: 'status.cli.uninstall.failed',
  });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('verify 五态与 kind 四词逐字锁死', () => {
  assert.deepStrictEqual(C.KEYS.verify, {
    verified: 'status.cli.verify.verified',
    'not-on-path': 'status.cli.verify.not-on-path',
    'shadowed-file': 'status.cli.verify.shadowed-file',
    'shadowed-kind': 'status.cli.verify.shadowed-kind',
    unknown: 'status.cli.verify.unknown',
  });
  assert.deepStrictEqual(C.KEYS.kind, {
    alias: 'status.cli.kind.alias',
    function: 'status.cli.kind.function',
    builtin: 'status.cli.kind.builtin',
    keyword: 'status.cli.kind.keyword',
  });
  assert.strictEqual(C.KEYS.uninstallNone, 'status.cli.uninstall.none');
});

// ── 安装：逐条结论 ─────────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('install 的每种已知结果映射到自己的键，路径原样带进 vars', () => {
  const cases = [
    ['installed', 'status.cli.install.installed'],
    ['replaced', 'status.cli.install.replaced'],
    ['already', 'status.cli.install.already'],
    ['conflict', 'status.cli.install.conflict'],
    ['refused', 'status.cli.install.refused'],
    ['failed', 'status.cli.install.failed'],
    ['cancelled', 'status.cli.install.cancelled'],
  ];
  for (const pair of cases) {
    const lines = C.summarize({ action: 'install', candidates: [cand(pair[0], '/usr/local/bin/rmd')] });
    assert.strictEqual(lines.length, 1, pair[0]);
    assert.strictEqual(lines[0].key, pair[1], pair[0]);
    assert.deepStrictEqual(lines[0].vars, { path: '/usr/local/bin/rmd' }, pair[0]);
  }
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('认不出的结果退回 failed 并把原文放进 detail（⛔ 不静默丢）', () => {
  const lines = C.summarize({ action: 'install', candidates: [cand('brand-new', '/x')] });
  assert.strictEqual(lines[0].key, 'status.cli.install.failed');
  assert.deepStrictEqual(lines[0].vars, { path: '/x', detail: 'brand-new' });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('结果为空 / 缺失时 detail 用 "?" 占位', () => {
  const lines = C.summarize({ action: 'install', candidates: [{ path: '/x' }] });
  assert.strictEqual(lines[0].key, 'status.cli.install.failed');
  assert.strictEqual(lines[0].vars.detail, '?');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('已知结果带 detail 时一并透传；没有 detail 时 vars 里不出现这个键', () => {
  const withDetail = C.summarize({
    action: 'install', candidates: [cand('failed', '/x', 'EACCES')],
  });
  assert.deepStrictEqual(withDetail[0].vars, { path: '/x', detail: 'EACCES' });
  const without = C.summarize({ action: 'install', candidates: [cand('installed', '/x')] });
  assert.strictEqual('detail' in without[0].vars, false);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('路径含空格 / 中文时原样保留，不做 shell 转义', () => {
  const lines = C.summarize({
    action: 'install', candidates: [cand('installed', '/Users/example user/bin/my tool')],
  });
  assert.strictEqual(lines[0].vars.path, '/Users/example user/bin/my tool');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('install 带 verify 时多出第二行；verify 缺失时只有候选行', () => {
  const base = { action: 'install', candidates: [cand('installed', '/bin/rmd')] };
  assert.strictEqual(C.summarize(base).length, 1);
  const withVerify = C.summarize(Object.assign({}, base, { verify: { state: 'verified' } }));
  assert.strictEqual(withVerify.length, 2);
  assert.strictEqual(withVerify[1].key, 'status.cli.verify.verified');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('action 缺失或认不出时按 install 渲染（⛔ 什么都不显示）', () => {
  const cands = [cand('installed', '/bin/rmd')];
  assert.strictEqual(C.summarize({ candidates: cands })[0].key, 'status.cli.install.installed');
  assert.strictEqual(C.summarize({ action: 'bogus', candidates: cands })[0].key, 'status.cli.install.installed');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('candidates 不是数组时得到空结论，⛔ 不抛', () => {
  assert.deepStrictEqual(C.summarize({ action: 'install', candidates: null }), []);
  assert.deepStrictEqual(C.summarize({}), []);
  assert.deepStrictEqual(C.summarize(null), []);
});

// ── 卸载：唯一允许的合并 ───────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('两个落点都 absent ⇒ 合并成一句，两个路径分进 a / b', () => {
  const lines = C.summarize({
    action: 'uninstall',
    candidates: [cand('absent', '/usr/local/bin/rmd'), cand('absent', '/usr/bin/rmd')],
  });
  assert.deepStrictEqual(lines, [{
    key: 'status.cli.uninstall.none',
    vars: { a: '/usr/local/bin/rmd', b: '/usr/bin/rmd' },
  }]);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('只要有一条不是 absent 就逐条说，⛔ 不合并成"什么都没做"', () => {
  const lines = C.summarize({
    action: 'uninstall',
    candidates: [cand('uninstalled', '/a'), cand('absent', '/b')],
  });
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].key, 'status.cli.uninstall.uninstalled');
  assert.strictEqual(lines[1].key, 'status.cli.uninstall.absent');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('恰好一个落点时即使 absent 也不合并（缺参数模板会露馅）', () => {
  const lines = C.summarize({ action: 'uninstall', candidates: [cand('absent', '/a')] });
  assert.deepStrictEqual(lines, [{
    key: 'status.cli.uninstall.absent', vars: { path: '/a' },
  }]);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('三个落点全 absent 时也逐条说（形状不符合 INV-CLI-16 就不硬套）', () => {
  const lines = C.summarize({
    action: 'uninstall',
    candidates: [cand('absent', '/a'), cand('absent', '/b'), cand('absent', '/c')],
  });
  assert.strictEqual(lines.length, 3);
  assert.ok(lines.every(function (l) { return l.key === 'status.cli.uninstall.absent'; }));
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('卸载的未知结果退回 uninstall.failed，并带上原文', () => {
  const lines = C.summarize({ action: 'uninstall', candidates: [cand('weird', '/a')] });
  assert.strictEqual(lines[0].key, 'status.cli.uninstall.failed');
  assert.deepStrictEqual(lines[0].vars, { path: '/a', detail: 'weird' });
});

// ── verify：四态与路径现算 ────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('verified 只要一句，无占位符', () => {
  const lines = C.summarize({
    action: 'install', candidates: [cand('installed', '/bin/rmd')], verify: { state: 'verified' },
  });
  assert.deepStrictEqual(lines[1], { key: 'status.cli.verify.verified', vars: {} });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('not-on-path 的目录从链接路径现算，不另开后端字段', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [cand('installed', '/usr/local/bin/rmd')],
    verify: { state: 'not-on-path' },
  });
  assert.deepStrictEqual(lines[1], {
    key: 'status.cli.verify.not-on-path',
    vars: { dir: '/usr/local/bin', path: '/usr/local/bin/rmd' },
  });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('not-on-path：路径含空格时目录照样切对', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [cand('installed', '/Users/example user/bin/my tool/rmd')],
    verify: { state: 'not-on-path' },
  });
  assert.strictEqual(lines[1].vars.dir, '/Users/example user/bin/my tool');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('not-on-path：没有斜杠时 dir 就是路径本身；根下的 /rmd 也原样', () => {
  const bare = C.summarize({
    action: 'install', candidates: [cand('installed', 'rmd')], verify: { state: 'not-on-path' },
  });
  assert.strictEqual(bare[1].vars.dir, 'rmd');
  const root = C.summarize({
    action: 'install', candidates: [cand('installed', '/rmd')], verify: { state: 'not-on-path' },
  });
  // ⚠️ 疑似缺陷：lastIndexOf('/') === 0 时 i > 0 不成立，dir 退化成完整路径。
  assert.strictEqual(root[1].vars.dir, '/rmd');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('shadowed + kind=file ⇒ 被文件挡住，带那个文件的路径', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [cand('installed', '/bin/rmd')],
    verify: { state: 'shadowed', kind: 'file', path: '/opt/homebrew/bin/rmd' },
  });
  assert.deepStrictEqual(lines[1], {
    key: 'status.cli.verify.shadowed-file',
    vars: { path: '/opt/homebrew/bin/rmd' },
  });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('shadowed + 已知 kind ⇒ 嵌套键，四词各自对应', () => {
  const cases = [
    ['alias', 'status.cli.kind.alias'],
    ['function', 'status.cli.kind.function'],
    ['builtin', 'status.cli.kind.builtin'],
    ['keyword', 'status.cli.kind.keyword'],
  ];
  for (const pair of cases) {
    const lines = C.summarize({
      action: 'install',
      candidates: [cand('installed', '/bin/rmd')],
      verify: { state: 'shadowed', kind: pair[0] },
    });
    assert.strictEqual(lines[1].key, 'status.cli.verify.shadowed-kind');
    assert.deepStrictEqual(lines[1].vars, { kind: { k: pair[1] } });
  }
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('shadowed + 叫不出名字的 kind ⇒ unknown，⛔ 不许硬套"被别名挡住"', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [cand('installed', '/bin/rmd')],
    verify: { state: 'shadowed', kind: 'mystery' },
  });
  assert.deepStrictEqual(lines[1], { key: 'status.cli.verify.unknown', vars: {} });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('未知 state / 缺 state / 非对象 verify 都归 unknown', () => {
  for (const v of [{ state: 'weird' }, {}, null]) {
    const lines = C.summarize({
      action: 'install', candidates: [cand('installed', '/bin/rmd')], verify: v,
    });
    if (v === null) {
      assert.strictEqual(lines.length, 1, 'verify=null 不追加行');
    } else {
      assert.deepStrictEqual(lines[1], { key: 'status.cli.verify.unknown', vars: {} });
    }
  }
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('verify 存在但候选为空时，not-on-path 的路径是空串', () => {
  const lines = C.summarize({ action: 'install', candidates: [], verify: { state: 'not-on-path' } });
  assert.deepStrictEqual(lines, [{
    key: 'status.cli.verify.not-on-path', vars: { dir: '', path: '' },
  }]);
});

// ── render：当场翻译，嵌套词条也跟着语言 ─────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('缺省不注入字典时直接用键名，多句用 " · " 连接', () => {
  const lines = C.summarize({
    action: 'install', candidates: [cand('installed', '/bin/rmd')], verify: { state: 'verified' },
  });
  assert.strictEqual(
    C.render(lines),
    'status.cli.install.installed · status.cli.verify.verified'
  );
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('render 把 vars 交给 t 做插值', () => {
  const seen = [];
  const tr = function (k, vars) { seen.push([k, vars]); return k + JSON.stringify(vars); };
  const lines = [{ key: 'k', vars: { path: '/a b', n: 3 } }];
  assert.strictEqual(C.render(lines, tr), 'k{"path":"/a b","n":3}');
  assert.deepStrictEqual(seen, [['k', { path: '/a b', n: 3 }]]);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('嵌套 kind 在 render 那一刻翻译：换语言整句重画', () => {
  const lines = C.summarize({
    action: 'install',
    candidates: [cand('installed', '/bin/rmd')],
    verify: { state: 'shadowed', kind: 'alias' },
  });
  const zh = C.render(lines, function (k, vars) {
    if (k === 'status.cli.kind.alias') return '别名';
    if (k === 'status.cli.verify.shadowed-kind') return '被' + vars.kind + '挡住';
    return k;
  });
  const en = C.render(lines, function (k, vars) {
    if (k === 'status.cli.kind.alias') return 'alias';
    if (k === 'status.cli.verify.shadowed-kind') return 'shadowed by ' + vars.kind;
    return k;
  });
  assert.ok(zh.indexOf('被别名挡住') >= 0, zh);
  assert.ok(en.indexOf('shadowed by alias') >= 0, en);
  assert.ok(en.indexOf('别名') < 0);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('render：空数组 / 非数组 / null 都安全；null 行会抛', () => {
  assert.strictEqual(C.render([], function (k) { return k; }), '');
  assert.strictEqual(C.render(null), '');
  assert.strictEqual(C.render('x'), '');
  // ⚠️ 疑似缺陷：元素为 null 时仍去读 line.key，直接抛 TypeError。
  assert.throws(function () { C.render([null]); }, TypeError);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('render：t 返回空串的句子被过滤掉', () => {
  const lines = [{ key: 'a', vars: {} }, { key: 'b', vars: {} }];
  assert.strictEqual(C.render(lines, function (k) { return k === 'a' ? '' : 'B'; }), 'B');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('render：非函数 tr 退回键名，不抛', () => {
  assert.strictEqual(C.render([{ key: 'x', vars: {} }], 'nope'), 'x');
});

// ── isError：哪些结果要报红 ───────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('install 的 conflict / refused / failed 报红，其余不报', () => {
  for (const r of ['conflict', 'refused', 'failed']) {
    assert.strictEqual(C.isError({ action: 'install', candidates: [cand(r, '/x')] }), true, r);
  }
  for (const r of ['installed', 'replaced', 'already', 'cancelled', 'brand-new']) {
    assert.strictEqual(C.isError({ action: 'install', candidates: [cand(r, '/x')] }), false, r);
  }
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('uninstall 只有 not-ours / failed 报红；absent / cancelled 是正常结局', () => {
  for (const r of ['not-ours', 'failed']) {
    assert.strictEqual(C.isError({ action: 'uninstall', candidates: [cand(r, '/x')] }), true, r);
  }
  for (const r of ['uninstalled', 'absent', 'cancelled']) {
    assert.strictEqual(C.isError({ action: 'uninstall', candidates: [cand(r, '/x')] }), false, r);
  }
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('多条候选中任意一条报红就报红', () => {
  assert.strictEqual(C.isError({
    action: 'uninstall', candidates: [cand('absent', '/a'), cand('not-ours', '/b')],
  }), true);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('action 缺失 / 未知时按 install 的报红口径', () => {
  assert.strictEqual(C.isError({ candidates: [cand('conflict', '/x')] }), true);
  assert.strictEqual(C.isError({ action: 'bogus', candidates: [cand('failed', '/x')] }), true);
  assert.strictEqual(C.isError({ action: 'bogus', candidates: [cand('not-ours', '/x')] }), false);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('空载荷 / 非数组候选都不报红', () => {
  assert.strictEqual(C.isError(null), false);
  assert.strictEqual(C.isError({}), false);
  assert.strictEqual(C.isError({ action: 'install', candidates: null }), false);
});
