// Vim 装配层：模式切换的数据必须只落在上游公开 API 上，宿主键位只登记一次，`:w` 只走既有保存器。
// 本文件从 docs/bugs 的历史缺陷出发，守住「Vim 正常模式下绕过约束改文档 / `:w` 静默 no-op / 键位叠加」。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load() {
  const src = fs.readFileSync(path.join(ROOT, 'src/editor/vim.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd.editorVim;
}

const V = load();

function fakeCM6() {
  const seen = [];
  return {
    seen: seen,
    vim: function (opts) {
      seen.push(opts);
      return [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    },
  };
}

function fakeVim() {
  return {
    maps: [],
    ex: Object.create(null),
    mapCommand: function (keys, type, name, args, extra) {
      this.maps.push({ keys: keys, type: type, name: name, args: args, extra: extra || {} });
    },
    defineEx: function (name, short, fn) {
      this.ex[name] = { short: short, fn: fn };
    },
  };
}

/**
 * 按上游文档的 `commandMatches` 语义判断一条 mapCommand 在某个模式下是否命中。
 * ⚠️ 这是测试侧的独立模型，⛔ 不是把产品实现抄一遍：
 *    · insert：只认 `context === 'insert'`；
 *    · normal：`context` 缺省或 `'normal'` 命中；
 *    · visual：`context` 缺省或 `'visual'` 命中（`'normal'` / `'insert'` 不命中）。
 */
function matches(map, mode) {
  const ctx = map.extra.context;
  if (mode === 'insert') return ctx === 'insert';
  if (mode === 'normal') return ctx === undefined || ctx === 'normal';
  if (mode === 'visual') return ctx === undefined || ctx === 'visual';
  return false;
}

function hits(Vim, mode, key) {
  return Vim.maps.filter(function (m) {
    return m.keys === key && matches(m, mode);
  });
}

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0009（编辑态开着 Vim 时，`:` 与 `/` 的输入框在「主题 ≠ 系统外观」下是隐形的）
// ——————————————————————————————————————————————————————————————

test('build 默认向上游要模式面板（status=true），不自研指示器', () => {
  const CM6 = fakeCM6();
  V.build(CM6);
  assert.deepStrictEqual(CM6.seen, [{ status: true }]);
});

test('build 把 false 原样传下去，不因省略参数而误开面板', () => {
  const CM6 = fakeCM6();
  V.build(CM6, { status: false });
  assert.deepStrictEqual(CM6.seen, [{ status: false }]);
});

test('build 对真值 / 假值按布尔收：0 与空串是 false，字符串是真', () => {
  const CM6 = fakeCM6();
  V.build(CM6, { status: 0 });
  V.build(CM6, { status: '' });
  V.build(CM6, { status: 'yes' });
  V.build(CM6, null);
  assert.deepStrictEqual(CM6.seen, [
    { status: false }, { status: false }, { status: true }, { status: true },
  ]);
});

test('build 原样交回上游数组本体：不包装、不复制、不重排（INV-VIM-01）', () => {
  const arr = [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }];
  const CM6 = { vim: function () { return arr; } };
  const out = V.build(CM6);
  assert.strictEqual(out, arr);
  assert.strictEqual(out.length, 4);
  out.forEach(function (x, i) { assert.strictEqual(x, arr[i]); });
});

test('build 只碰 CM6.vim：不访问 Prec（没有 higher 这个成员，包了就是 TypeError）', () => {
  const CM6 = {
    vim: function () { return [1, 2, 3, 4]; },
    get Prec() { throw new Error('不该碰 Prec'); },
  };
  assert.deepStrictEqual(V.build(CM6), [1, 2, 3, 4]);
});

test('build 不调用上游别的导出（只走 vim 一个入口）', () => {
  const calls = [];
  const CM6 = new Proxy({ vim: function () { calls.push('vim'); return []; } }, {
    get: function (target, key) {
      if (key === 'vim') return target.vim;
      throw new Error('不该访问 ' + String(key));
    },
  });
  assert.deepStrictEqual(V.build(CM6), []);
  assert.deepStrictEqual(calls, ['vim']);
});

test('`：w` 覆盖的是上游默认实现，而不是新增第二条写路径', () => {
  const Vim = fakeVim();
  let upstream = 0;
  Vim.ex.w = { short: 'w', fn: function () { upstream++; } };
  const calls = [];
  const fn = V.installEx(Vim, function () { calls.push(1); });
  assert.strictEqual(Vim.ex.write.fn, fn);
  Vim.ex.write.fn({}, {});
  assert.deepStrictEqual(calls, [1]);
  assert.strictEqual(upstream, 0);
});

test('installEx 只注册 write / w 这一条 ex 命令（⛔ 不顺手注册 :q）', () => {
  const Vim = fakeVim();
  V.installEx(Vim, function () {});
  assert.deepStrictEqual(Object.keys(Vim.ex), ['write']);
  assert.strictEqual(Vim.ex.write.short, 'w');
});

test('installEx 交回的函数就是注册进 defineEx 的那个函数', () => {
  const Vim = fakeVim();
  const fn = V.installEx(Vim, function () {});
  assert.strictEqual(Vim.ex.write.fn, fn);
});

test('`:w` 每次执行都重新调「取当前保存器」的取值函数', () => {
  const Vim = fakeVim();
  const seen = [];
  let current = function () { seen.push('first'); };
  const fn = V.installEx(Vim, function () { current(); });
  fn();
  current = function () { seen.push('second'); };
  fn();
  assert.deepStrictEqual(seen, ['first', 'second']);
});

test('`:w` 只发一跳：保存器不会被调两次、也不被传参', () => {
  const Vim = fakeVim();
  let count = 0;
  let argc = -1;
  const fn = V.installEx(Vim, function () {
    count++;
    argc = arguments.length;
  });
  fn({}, { args: 'whatever' });
  assert.strictEqual(count, 1);
  assert.strictEqual(argc, 0);
});

test('`:w` 不 await 保存器：promise 还没落地时函数已经返回 undefined', () => {
  let landed = false;
  const fn = V.installEx(fakeVim(), function () {
    return Promise.resolve().then(function () { landed = true; });
  });
  assert.strictEqual(fn(), undefined);
  assert.strictEqual(landed, false);
});

test('`:w` 不 catch 保存器抛出的错：异常照常上抛（⛔ 在这里改状态）', () => {
  const fn = V.installEx(fakeVim(), function () { throw new Error('save-down'); });
  assert.throws(function () { fn(); }, /save-down/);
});

test('`:w` 不看 cm.save：上游那条兜底路径在我们 bundle 里不存在', () => {
  const Vim = fakeVim();
  let legacy = 0;
  const cm = { save: function () { legacy++; } };
  const fn = V.installEx(Vim, function () {});
  fn(cm, {});
  assert.strictEqual(legacy, 0);
});

test('`:w` 不读 params.callback（上游会在 promise 落地前就调它）', () => {
  const Vim = fakeVim();
  let callback = 0;
  V.installEx(Vim, function () {});
  Vim.ex.write.fn({}, { callback: function () { callback++; } });
  assert.strictEqual(callback, 0);
});

test('installEx 重复装配是赋值覆盖，同一个 ex 名不会堆叠', () => {
  const Vim = fakeVim();
  const a = V.installEx(Vim, function () {});
  const b = V.installEx(Vim, function () {});
  assert.notStrictEqual(a, b);
  assert.strictEqual(Vim.ex.write.fn, b);
  assert.deepStrictEqual(Object.keys(Vim.ex), ['write']);
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0096（probe-vim-keys 的三条判据漂移与撤销栈状态污染）
// ——————————————————————————————————————————————————————————————

test('hostKeys 只登记三条：C-h 转 BS、C-k 两条 idle（normal/visual ＋ insert）', () => {
  const Vim = fakeVim();
  assert.strictEqual(V.hostKeys(Vim), true);
  assert.deepStrictEqual(Vim.maps.map(function (m) { return [m.keys, m.type]; }), [
    ['<C-h>', 'keyToKey'],
    ['<C-k>', 'idle'],
    ['<C-k>', 'idle'],
  ]);
});

test('C-h 在 normal 与 visual 各命中一次，insert 一次都不命中（自动保留 WebKit 退格）', () => {
  const Vim = fakeVim();
  V.hostKeys(Vim);
  assert.strictEqual(hits(Vim, 'normal', '<C-h>').length, 1);
  assert.strictEqual(hits(Vim, 'visual', '<C-h>').length, 1);
  assert.strictEqual(hits(Vim, 'insert', '<C-h>').length, 0);
});

test('C-k 在 normal / visual 各命中一次，且都是 no-op idle', () => {
  const Vim = fakeVim();
  V.hostKeys(Vim);
  const normal = hits(Vim, 'normal', '<C-k>');
  const visual = hits(Vim, 'visual', '<C-k>');
  assert.strictEqual(normal.length, 1);
  assert.strictEqual(visual.length, 1);
  assert.strictEqual(normal[0].type, 'idle');
  assert.strictEqual(visual[0].type, 'idle');
});

test('C-k 在 insert 单独命中一次：不写 context 的那条到不了 insert', () => {
  const Vim = fakeVim();
  V.hostKeys(Vim);
  const insert = hits(Vim, 'insert', '<C-k>');
  assert.strictEqual(insert.length, 1);
  assert.strictEqual(insert[0].type, 'idle');
  assert.strictEqual(insert[0].extra.context, 'insert');
});

test('C-h 的 extra 只有 toKeys=<BS>，不写 context', () => {
  const Vim = fakeVim();
  V.hostKeys(Vim);
  const ch = Vim.maps[0];
  assert.deepStrictEqual(ch.extra, { toKeys: '<BS>' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ch.extra, 'context'), false);
});

test('C-k（normal/visual）的 extra 为空对象，不写 context', () => {
  const Vim = fakeVim();
  V.hostKeys(Vim);
  assert.deepStrictEqual(Vim.maps[1].extra, {});
});

test('hostKeys 不登记裸键（历史例：F2；`view.start` 含 ⌘，2026-11-16 起是 `⌘L`）', () => {
  // ⚠️ 这条原本钉的是「`design/0056` 的裸 F2 不进编辑态转发」。裸 F-键在本机到不了应用
  //    （`bugs/0097`）⇒ `view.start` 已改 `⇧⌘H`，**含 ⌘** ⇒ 它由下面那条「不登记任何 ⌘ 键」管。
  //    ⇒ 本条保留的判据变成"hostKeys 不碰裸键"这个一般形态，⛔ 别读成"真表里还有裸键"。
  const Vim = fakeVim();
  V.hostKeys(Vim);
  assert.strictEqual(Vim.maps.some(function (m) { return m.keys === 'F2'; }), false);
  assert.strictEqual(Vim.maps.some(function (m) { return /F/.test(m.keys); }), false,
    '⛔ hostKeys 的键全在 Ctrl 面，⛔ 不掺功能键');
});

test('hostKeys 不登记任何 ⌘ 键（Ctrl 组合留给 Vim，⌘ 属于应用转发层）', () => {
  const Vim = fakeVim();
  V.hostKeys(Vim);
  for (const m of Vim.maps) {
    assert.match(m.keys, /^<C-[a-z]>$/);
  }
});

test('hostKeys 不登记 C-z / C-r：撤销栈归 CM6 的 historyKeymap，⛔ 不抢', () => {
  const Vim = fakeVim();
  V.hostKeys(Vim);
  for (const m of Vim.maps) {
    assert.notStrictEqual(m.keys, '<C-z>');
    assert.notStrictEqual(m.keys, '<C-r>');
  }
});

test('hostKeys 只用公开的 mapCommand，不碰 vim() 返回的四个扩展', () => {
  const Vim = { mapCommand: function () {} };
  assert.strictEqual(V.hostKeys(Vim), true);
});

test('hostKeys 幂等：第二次返回 false 且一条都不再登记', () => {
  const Vim = fakeVim();
  assert.strictEqual(V.hostKeys(Vim), true);
  assert.strictEqual(V.hostKeys(Vim), false);
  assert.strictEqual(Vim.maps.length, 3);
});

test('hostKeys 的幂等标记挂在 Vim 单例上：两个实例各登记一次', () => {
  const a = fakeVim();
  const b = fakeVim();
  assert.strictEqual(V.hostKeys(a), true);
  assert.strictEqual(V.hostKeys(b), true);
  assert.strictEqual(a.maps.length, 3);
  assert.strictEqual(b.maps.length, 3);
  assert.strictEqual(V.hostKeys(a), false);
  assert.strictEqual(a.maps.length, 3);
});

test('已带标记的 Vim 直接返回 false，不读 mapCommand（防止脏对象炸装配）', () => {
  assert.strictEqual(V.hostKeys({ __rmdVimHostKeys: true }), false);
});

test('hostKeys 第三次 / 第四次调用仍然不叠加（unshift 的叠加形态被挡住）', () => {
  const Vim = fakeVim();
  V.hostKeys(Vim);
  V.hostKeys(Vim);
  V.hostKeys(Vim);
  assert.strictEqual(Vim.maps.length, 3);
});

test('hostKeys 在 Vim 上留下的标记只影响该实例', () => {
  const a = fakeVim();
  const b = fakeVim();
  V.hostKeys(a);
  assert.strictEqual(b.__rmdVimHostKeys, undefined);
  V.hostKeys(b);
  assert.strictEqual(b.__rmdVimHostKeys, true);
});

test('hostKeys 的返回值是「这次真的登记了吗」：true 只出现一次', () => {
  const Vim = fakeVim();
  const seq = [V.hostKeys(Vim), V.hostKeys(Vim), V.hostKeys(Vim)];
  assert.deepStrictEqual(seq, [true, false, false]);
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0020（⌘Z 不能撤销编辑）：Vim 层不得另造撤销入口
// ——————————————————————————————————————————————————————————————

test('hostKeys 不注册 C-z / C-r / C-y（撤销重做只有一条历史路径）', () => {
  const Vim = fakeVim();
  V.hostKeys(Vim);
  const keys = Vim.maps.map(function (m) { return m.keys; });
  assert.deepStrictEqual(keys, ['<C-h>', '<C-k>', '<C-k>']);
});

test('installEx 不注册 undo / redo 之类 ex 命令', () => {
  const Vim = fakeVim();
  V.installEx(Vim, function () {});
  assert.deepStrictEqual(Object.keys(Vim.ex), ['write']);
});

test('hostKeys 不依赖 Vim.defineEx（宿主键位与保存器正交）', () => {
  const Vim = { mapCommand: function () {} };
  assert.strictEqual(V.hostKeys(Vim), true);
});
