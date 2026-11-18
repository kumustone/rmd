// Vim 装配层：扩展原样交回、`:w` 只调既有保存器、`⌃H` / `⌃K` 的宿主键位只登记一次。
// 守的是 `INV-VIM-01/03` 与 `design/0014` §2.3-5（不写 context ⇒ normal ＋ visual，不含 insert）。
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

test('build 默认向上游要模式面板（status=true）', () => {
  const seen = [];
  const CM6 = {
    vim: function (opts) {
      seen.push(opts);
      return [1, 2, 3, 4];
    },
  };
  assert.deepStrictEqual(V.build(CM6), [1, 2, 3, 4]);
  assert.deepStrictEqual(seen, [{ status: true }]);
});

test('build 把 status 原样传下去：false / 0 / 真值都按布尔收', () => {
  const seen = [];
  const CM6 = {
    vim: function (opts) {
      seen.push(opts);
      return [];
    },
  };
  V.build(CM6, { status: false });
  V.build(CM6, { status: 0 });
  V.build(CM6, { status: 'yes' });
  V.build(CM6, null);
  assert.deepStrictEqual(seen, [
    { status: false }, { status: false }, { status: true }, { status: true },
  ]);
});

test('build 原样交回上游数组本体，不包装、不复制、不重排', () => {
  const ext = [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }];
  const CM6 = { vim: function () { return ext; } };
  const out = V.build(CM6, { status: true });
  assert.strictEqual(out, ext);
  assert.strictEqual(out.length, 4);
  out.forEach(function (item, i) {
    assert.strictEqual(item, ext[i]);
  });
});

test('installEx 注册 write / w 两条名字，交回同一个函数', () => {
  const calls = [];
  const Vim = {
    defineEx: function (name, short, fn) {
      calls.push({ name: name, short: short, fn: fn });
    },
  };
  const save = function () {};
  const fn = V.installEx(Vim, save);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, 'write');
  assert.strictEqual(calls[0].short, 'w');
  assert.strictEqual(calls[0].fn, fn);
});

test('installEx 的 :w 只发一跳保存，不 await、不看返回值、不 catch', () => {
  let saves = 0;
  let resolved = false;
  const Vim = { defineEx: function (name, short, fn) { this.fn = fn; } };
  const fn = V.installEx(Vim, function () {
    saves++;
    return Promise.resolve().then(function () { resolved = true; });
  });
  assert.strictEqual(fn({}, {}), undefined);
  assert.strictEqual(saves, 1);
  assert.strictEqual(resolved, false);
});

test('installEx 每次执行都重新调取值函数给的保存器，不缓存结果', () => {
  const seen = [];
  let current = function () { seen.push('first'); };
  const Vim = { defineEx: function (name, short, fn) { this.fn = fn; } };
  const fn = V.installEx(Vim, function () { current(); });
  fn();
  current = function () { seen.push('second'); };
  fn();
  assert.deepStrictEqual(seen, ['first', 'second']);
});

test('installEx 幂等：重复装配只是把同一个形状再赋值一次，不堆条目', () => {
  const defs = [];
  const Vim = {
    defineEx: function (name, short, fn) {
      defs.push([name, short]);
    },
  };
  const one = V.installEx(Vim, function () {});
  const two = V.installEx(Vim, function () {});
  assert.deepStrictEqual(defs, [['write', 'w'], ['write', 'w']]);
  assert.notStrictEqual(one, two);
});

test('hostKeys 第一次登记三条：C-h 转 BS、C-k 两条 idle（normal/visual ＋ insert）', () => {
  const calls = [];
  const Vim = {
    mapCommand: function () {
      calls.push(Array.prototype.slice.call(arguments));
    },
  };
  assert.strictEqual(V.hostKeys(Vim), true);
  assert.deepStrictEqual(calls, [
    ['<C-h>', 'keyToKey', undefined, undefined, { toKeys: '<BS>' }],
    ['<C-k>', 'idle', undefined, undefined, {}],
    ['<C-k>', 'idle', undefined, undefined, { context: 'insert' }],
  ]);
});

test('hostKeys 的前两条都不写 context（normal ＋ visual，insert 自动跳过）', () => {
  const calls = [];
  const Vim = {
    mapCommand: function (keys, type, name, args, extra) {
      calls.push({ keys: keys, extra: extra });
    },
  };
  V.hostKeys(Vim);
  const cH = calls[0].extra;
  const cK = calls[1].extra;
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cH, 'context'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cK, 'context'), false);
  assert.strictEqual(calls[2].extra.context, 'insert');
});

test('hostKeys 幂等：第二次返回 false 且一条都不再登记', () => {
  let count = 0;
  const Vim = {
    mapCommand: function () {
      count++;
    },
  };
  assert.strictEqual(V.hostKeys(Vim), true);
  assert.strictEqual(V.hostKeys(Vim), false);
  assert.strictEqual(count, 3);
  assert.strictEqual(Vim.__rmdVimHostKeys, true);
});

test('hostKeys 的幂等标记挂在 Vim 单例上，两个实例各登记一次', () => {
  const a = { count: 0, mapCommand: function () { a.count++; } };
  const b = { count: 0, mapCommand: function () { b.count++; } };
  assert.strictEqual(V.hostKeys(a), true);
  assert.strictEqual(V.hostKeys(b), true);
  assert.strictEqual(a.count, 3);
  assert.strictEqual(b.count, 3);
  assert.strictEqual(V.hostKeys(a), false);
  assert.strictEqual(a.count, 3);
});

test('hostKeys 已带标记时直接返回 false，不读 mapCommand', () => {
  const Vim = { __rmdVimHostKeys: true };
  assert.strictEqual(V.hostKeys(Vim), false);
});
