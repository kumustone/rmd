// 编辑区按键转发：白名单必须从按键表派生、非按 Shift 的键名要响亮跳过、转发垫片必须复位。
// 守的是 `INV-SET-01/02/05`、`INV-EDIT-09` 与「编辑区里应用键不能静默失效」。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadAll() {
  const win = {};
  for (const rel of ['src/services/keymap.js', 'src/editor/keys.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    new Function('window', src)(win);
  }
  return win;
}

const W = loadAll();
const K = W.rmd.keymap;
const E = W.rmd.editorKeys;

test('免Shift 只收字母、数字与不按 Shift 就能敲出的符号', () => {
  for (const ch of ['a', 'z', '0', '9', '-', '=', '[', ']', '\\', ';', ',', '.', '/']) {
    assert.strictEqual(E.免Shift.test(ch), true, ch);
  }
  for (const ch of ['A', '+', '_', '`', "'", '{', '}', ' ', '中']) {
    assert.strictEqual(E.免Shift.test(ch), false, ch);
  }
});

test('toCM6Spec 把 Cmd 折成 Mod、字母折小写', () => {
  assert.strictEqual(E.toCM6Spec('Cmd+S'), 'Mod-s');
  assert.strictEqual(E.toCM6Spec('Command+Shift+Z'), 'Mod-Shift-z');
  assert.strictEqual(E.toCM6Spec('Cmd+Alt+P'), 'Mod-Alt-p');
  assert.strictEqual(E.toCM6Spec('Ctrl+J'), 'Ctrl-j');
});

test('toCM6Spec 对重复修饰键去重，不改出现顺序', () => {
  assert.strictEqual(E.toCM6Spec('Cmd+Command+Shift+S'), 'Mod-Shift-s');
  assert.strictEqual(E.toCM6Spec('Alt+Option+X'), 'Alt-x');
});

test('toCM6Spec 保住尾位的连字符与等号（⌘- / ⌘= 可达）', () => {
  assert.strictEqual(E.toCM6Spec('Cmd+-'), 'Mod--');
  assert.strictEqual(E.toCM6Spec('Cmd+='), 'Mod-=');
  assert.strictEqual(E.toCM6Spec('Cmd+,'), 'Mod-,');
});

test('toCM6Spec 对空串 / 只有修饰段 / 解析不出键名返回 null', () => {
  assert.strictEqual(E.toCM6Spec(''), null);
  assert.strictEqual(E.toCM6Spec('Cmd'), null);
  assert.strictEqual(E.toCM6Spec(null), null);
});

test('toCM6Spec 对非按 Shift 敲不出来的键名返回 null，不造一个假串', () => {
  assert.strictEqual(E.toCM6Spec('Cmd++'), null);
  assert.strictEqual(E.toCM6Spec('Cmd+_'), null);
  assert.strictEqual(E.toCM6Spec('Cmd+`'), null);
  assert.strictEqual(E.toCM6Spec("Cmd+'"), null);
  assert.strictEqual(E.toCM6Spec('Cmd+?'), null);
});

function row(id, accel, owner) {
  return { id: id, accel: accel, owner: owner || 'web' };
}

test('deriveWhitelist 只收 owner=web，菜单项一个都不进白名单', () => {
  const out = E.deriveWhitelist([
    row('web.ok', 'Cmd+S'),
    row('menu.never', 'Cmd+Q', 'menu'),
  ]);
  assert.deepStrictEqual(out.specs, [{ id: 'web.ok', accel: 'Cmd+S', spec: 'Mod-s' }]);
  assert.deepStrictEqual(out.skipped, []);
  assert.deepStrictEqual(out.notes, []);
});

test('deriveWhitelist 对含 ctrl 的项只记 note，不转发（决策 3 预留）', () => {
  const out = E.deriveWhitelist([row('a', 'Ctrl+S'), row('b', 'Cmd+Ctrl+J')]);
  assert.deepStrictEqual(out.specs, []);
  assert.strictEqual(out.skipped.length, 0);
  assert.strictEqual(out.notes.length, 2);
  assert.match(out.notes[0].why, /含 ctrl/);
});

test('deriveWhitelist 对不含 cmd 的项报分叉，不进 specs', () => {
  const out = E.deriveWhitelist([row('a', 'Shift+K')]);
  assert.deepStrictEqual(out.specs, []);
  assert.strictEqual(out.skipped.length, 1);
  assert.match(out.skipped[0].why, /不含 cmd/);
});

test('deriveWhitelist 对 owner=web 却没有 accel 的项响亮报错', () => {
  const out = E.deriveWhitelist([row('a', '')]);
  assert.deepStrictEqual(out.specs, []);
  assert.strictEqual(out.skipped.length, 1);
  assert.match(out.skipped[0].why, /没有 accel/);
});

test('deriveWhitelist 对解析不出键名的 accel 进 skipped，而不是静默丢弃', () => {
  const out = E.deriveWhitelist([row('a', '   '), row('b', 'Cmd')]);
  assert.strictEqual(out.specs.length, 0);
  assert.strictEqual(out.skipped.length, 2);
  assert.match(out.skipped[0].why, /解析不出键名/);
});

test('deriveWhitelist 把 Cmd++ / Cmd+_ 这类别名式 accel 逐条报出', () => {
  const out = E.deriveWhitelist([row('font-inc', 'Cmd++'), row('font-dec', 'Cmd+_')]);
  assert.deepStrictEqual(out.specs, []);
  assert.strictEqual(out.skipped.length, 2);
  assert.match(out.skipped[0].why, /非按 Shift 敲不出来/);
  assert.match(out.skipped[1].why, /非按 Shift 敲不出来/);
});

test('deriveWhitelist 保留原表顺序与 id / accel / spec 三元组', () => {
  const out = E.deriveWhitelist([
    row('z.last', 'Cmd+L'),
    row('x.menu', 'Cmd+Q', 'menu'),
    row('a.first', 'Cmd+S'),
    row('skip.ctrl', 'Ctrl+S'),
    row('b.mid', 'Cmd+Shift+F'),
  ]);
  assert.deepStrictEqual(out.specs, [
    { id: 'z.last', accel: 'Cmd+L', spec: 'Mod-l' },
    { id: 'a.first', accel: 'Cmd+S', spec: 'Mod-s' },
    { id: 'b.mid', accel: 'Cmd+Shift+F', spec: 'Mod-Shift-f' },
  ]);
  assert.deepStrictEqual(out.notes, [
    { id: 'skip.ctrl', accel: 'Ctrl+S', why: '含 ctrl —— 刻意不转发（决策 3 预留）' },
  ]);
});

test('deriveWhitelist 对 null / 空表给三个空数组，不抛错', () => {
  assert.deepStrictEqual(E.deriveWhitelist(null), { specs: [], skipped: [], notes: [] });
  assert.deepStrictEqual(E.deriveWhitelist([]), { specs: [], skipped: [], notes: [] });
  assert.deepStrictEqual(
    E.deriveWhitelist([null, {}, row('ok', 'Cmd+S')]).specs.map(function (x) { return x.id; }),
    ['ok']
  );
});

test('deriveWhitelist 不读 aliases：别名不能旁路进入白名单', () => {
  const out = E.deriveWhitelist([{
    id: 'x', accel: 'Cmd+=', aliases: ['Cmd++'], owner: 'web',
  }]);
  assert.deepStrictEqual(out.specs, [{ id: 'x', accel: 'Cmd+=', spec: 'Mod-=' }]);
  assert.strictEqual(out.skipped.length, 0);
});

test('createForwardShim 未绑 keymap 时转发失败并响亮报错', () => {
  const errors = [];
  const old = console.error;
  console.error = function (m) {
    errors.push(String(m));
  };
  try {
    const shim = E.createForwardShim({ win: W });
    assert.strictEqual(shim.forward('x'), false);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /keymap 还没绑上/);
  } finally {
    console.error = old;
  }
});

test('createForwardShim 转发期间 editable() 让路，结束后立刻复位', () => {
  W.document = { activeElement: { isContentEditable: true } };
  try {
    const shim = E.createForwardShim({ win: W });
    const seen = [];
    const fake = {
      composition: { active: false },
      dispatch: function (id, source) {
        seen.push({
          id: id,
          source: source,
          forwarding: shim.isForwarding(),
          editable: shim.ctx.editable(),
        });
        return true;
      },
    };
    shim.bind(fake);
    assert.strictEqual(shim.ctx.editable(), true);
    assert.strictEqual(shim.forward('save'), true);
    assert.deepStrictEqual(seen, [
      { id: 'save', source: 'key', forwarding: true, editable: false },
    ]);
    assert.strictEqual(shim.isForwarding(), false);
    assert.strictEqual(shim.ctx.editable(), true);
  } finally {
    delete W.document;
  }
});

test('createForwardShim 在 dispatch 抛错时也复位 forwarding（finally）', () => {
  const shim = E.createForwardShim({ win: W });
  shim.bind({
    composition: { active: false },
    dispatch: function () {
      throw new Error('boom');
    },
  });
  assert.throws(function () { shim.forward('x'); }, /boom/);
  assert.strictEqual(shim.isForwarding(), false);
});

test('createForwardShim 的 compositionActive 直接读真实实例，不另存一份', () => {
  const shim = E.createForwardShim({ win: W });
  const fake = { composition: { active: false }, dispatch: function () { return true; } };
  shim.bind(fake);
  assert.strictEqual(shim.ctx.compositionActive(), false);
  fake.composition.active = true;
  assert.strictEqual(shim.ctx.compositionActive(), true);
});

test('createForwardShim 未绑实例时 compositionActive 为 false', () => {
  const shim = E.createForwardShim({ win: W });
  assert.strictEqual(shim.ctx.compositionActive(), false);
});

test('createForwardShim 的 editable 只认 input / textarea / contenteditable', () => {
  const shim = E.createForwardShim({ win: W });
  assert.strictEqual(shim.ctx.editable(), false);
  W.document = { activeElement: { tagName: 'INPUT' } };
  try {
    assert.strictEqual(shim.ctx.editable(), true);
    W.document.activeElement = { tagName: 'DIV' };
    assert.strictEqual(shim.ctx.editable(), false);
    W.document.activeElement = { tagName: 'DIV', isContentEditable: true };
    assert.strictEqual(shim.ctx.editable(), true);
  } finally {
    delete W.document;
  }
});

test('buildBindings 为每条 spec 生成一条键绑定，run 恒返回 true', () => {
  const calls = [];
  const CM6 = {
    Prec: { low: function (x) { return { level: 'low', value: x }; } },
    keymap: { of: function (list) { return { list: list }; } },
  };
  const out = E.buildBindings(CM6, [
    { id: 'save', spec: 'Mod-s' },
    { id: 'find', spec: 'Mod-f' },
  ], function (id) {
    calls.push(id);
    return false;
  });
  assert.strictEqual(out.level, 'low');
  assert.deepStrictEqual(out.value.list.map(function (b) { return b.key; }), ['Mod-s', 'Mod-f']);
  for (const b of out.value.list) {
    assert.strictEqual(b.run(), true);
  }
  assert.deepStrictEqual(calls, ['save', 'find']);
});

test('buildBindings 的 run 即使 handler 不存在也吃掉按键，不交给浏览器', () => {
  const CM6 = {
    Prec: { low: function (x) { return x; } },
    keymap: { of: function (list) { return list; } },
  };
  const out = E.buildBindings(CM6, [{ id: 'unknown', spec: 'Mod-p' }], function () {
    return false;
  });
  assert.strictEqual(out[0].run(), true);
});

test('buildBindings 对空 specs 也调用 Prec.low（装一个空扩展而不是 undefined）', () => {
  const seen = [];
  const CM6 = {
    Prec: { low: function (x) { seen.push(x); return { empty: x }; } },
    keymap: { of: function (list) { return list; } },
  };
  const out = E.buildBindings(CM6, [], function () { return true; });
  assert.deepStrictEqual(seen, [[]]);
  assert.deepStrictEqual(out.empty, []);
});

test('buildBindings 对缺 specs 按空数组处理', () => {
  const CM6 = {
    Prec: { low: function (x) { return x; } },
    keymap: { of: function (list) { return list; } },
  };
  assert.deepStrictEqual(E.buildBindings(CM6, null, function () {}), []);
});

test('真实 keymap 的 splitAccel 口径被复用：Cmd++ 的键名是 +、修饰只有 cmd', () => {
  assert.deepStrictEqual(K.splitAccel('Cmd++'), { mods: ['cmd'], key: '+' });
  assert.deepStrictEqual(K.splitAccel('Cmd+-'), { mods: ['cmd'], key: '-' });
  assert.deepStrictEqual(K.splitAccel('Cmd+Shift+='), { mods: ['cmd', 'shift'], key: '=' });
});

test('真实 keymap 的 normalizeKey 负责折小写，免Shift 再判可达性', () => {
  const sample = ['S', 's', '=', '+', '_', 'Z'];
  const normalized = sample.map(function (ch) {
    return K.normalizeKey(ch);
  });
  assert.deepStrictEqual(normalized, ['s', 's', '=', '+', '_', 'z']);
  const accepted = normalized.filter(function (ch) {
    return E.免Shift.test(ch);
  });
  assert.deepStrictEqual(accepted, ['s', 's', '=', 'z']);
});
