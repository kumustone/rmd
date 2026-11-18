// keymap 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：accel 切分的边角（末尾 + / 修饰键别名）、Shift 的字符蕴含、
// 裸 F2 与 ⌘A 的命中、快捷键冲突的先后、可编辑 / 组合态两条来源都要挡、
// 绑定表派生的响亮报错与跨语言自检。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'keymap.js'), 'utf8');

function loadKeymap() {
  const win = {};
  new Function('window', SRC)(win);
  return win.rmd.keymap;
}

const K = loadKeymap();

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

function makeKm(opts) {
  const o = opts || {};
  return K.createKeymap({ table: o.table || [], win: o.win, ctx: o.ctx });
}

// ── splitAccel：修饰键别名与末尾 + ────────────────────────────────

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('修饰键的 muda 别名都归到规范名：Command/Super/Meta 都是 cmd', () => {
  assert.deepStrictEqual(K.splitAccel('Command+O').mods, ['cmd']);
  assert.deepStrictEqual(K.splitAccel('Super+O').mods, ['cmd']);
  assert.deepStrictEqual(K.splitAccel('Meta+O').mods, ['cmd']);
  assert.deepStrictEqual(K.splitAccel('Control+O').mods, ['ctrl']);
  assert.deepStrictEqual(K.splitAccel('Option+O').mods, ['alt']);
  assert.deepStrictEqual(K.splitAccel('Opt+O').mods, ['alt']);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('修饰键大小写不敏感', () => {
  assert.deepStrictEqual(K.splitAccel('CMD+SHIFT+O').mods, ['cmd', 'shift']);
  assert.deepStrictEqual(K.splitAccel('ctrl+alt+O').mods, ['ctrl', 'alt']);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('末尾的 + 表示键名就是 +，修饰段尾部多余 + 被裁掉', () => {
  assert.deepStrictEqual(K.splitAccel('Cmd++'), { mods: ['cmd'], key: '+' });
  assert.deepStrictEqual(K.splitAccel('Shift+Cmd++'), { mods: ['shift', 'cmd'], key: '+' });
  assert.deepStrictEqual(K.splitAccel('++'), { mods: [], key: '+' });
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('未知名修饰段被忽略，键名不受影响', () => {
  assert.deepStrictEqual(K.splitAccel('Hyper+Cmd+O'), { mods: ['cmd'], key: 'O' });
  assert.deepStrictEqual(K.splitAccel('Fn+O'), { mods: [], key: 'O' });
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('加号两侧空白被容忍', () => {
  assert.deepStrictEqual(K.splitAccel(' Cmd + Shift + O '), { mods: ['cmd', 'shift'], key: 'O' });
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('重复修饰只留一个（顺序按首次出现）', () => {
  assert.deepStrictEqual(K.splitAccel('Shift+Cmd+Shift+O').mods, ['shift', 'cmd']);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('单符号键名不被当成修饰段', () => {
  assert.deepStrictEqual(K.splitAccel('Cmd+?'), { mods: ['cmd'], key: '?' });
  assert.deepStrictEqual(K.splitAccel('Cmd+ '), { mods: ['cmd'], key: '+' });
});

// ── normalizeKey / isShiftImplied ────────────────────────────────

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('normalizeKey：只有单个 ASCII 字母折小写，其余（含 F2 / é / 多字母）原样', () => {
  assert.strictEqual(K.normalizeKey('A'), 'a');
  assert.strictEqual(K.normalizeKey('F2'), 'F2');
  assert.strictEqual(K.normalizeKey('é'), 'é');
  assert.strictEqual(K.normalizeKey('AA'), 'AA');
  assert.strictEqual(K.normalizeKey(0), '0');
  assert.strictEqual(K.normalizeKey(''), '');
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('isShiftImplied：小写字母与数字之外都认为 Shift 已由字符蕴含', () => {
  assert.strictEqual(K.isShiftImplied('a'), false);
  assert.strictEqual(K.isShiftImplied('A'), false);
  assert.strictEqual(K.isShiftImplied('0'), false);
  assert.strictEqual(K.isShiftImplied('9'), false);
  assert.strictEqual(K.isShiftImplied('+'), true);
  assert.strictEqual(K.isShiftImplied('_'), true);
  assert.strictEqual(K.isShiftImplied('~'), true);
  assert.strictEqual(K.isShiftImplied('F2'), true);
  assert.strictEqual(K.isShiftImplied(''), true);
});

// ── matchAccel：裸功能键与 Shift 的边界 ──────────────────────────

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('裸 F2 命中无修饰的 F2；Shift+F2 也命中（Shift 被功能键蕴含）', () => {
  assert.strictEqual(K.matchAccel('F2', { key: 'F2' }), true);
  assert.strictEqual(K.matchAccel('F2', { key: 'F2', shiftKey: true }), true);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('裸 F2 不命中带 ⌘ / ⌃ / ⌥ 的按键', () => {
  assert.strictEqual(K.matchAccel('F2', { key: 'F2', metaKey: true }), false);
  assert.strictEqual(K.matchAccel('F2', { key: 'F2', ctrlKey: true }), false);
  assert.strictEqual(K.matchAccel('F2', { key: 'F2', altKey: true }), false);
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('⌘A 命中 metaKey+a / A，不命中 Shift / Ctrl / Alt 组合', () => {
  assert.strictEqual(K.matchAccel('Cmd+A', { metaKey: true, key: 'a' }), true);
  assert.strictEqual(K.matchAccel('Cmd+A', { metaKey: true, key: 'A' }), true);
  assert.strictEqual(K.matchAccel('Cmd+A', { metaKey: true, shiftKey: true, key: 'a' }), false);
  assert.strictEqual(K.matchAccel('Cmd+A', { ctrlKey: true, key: 'a' }), false);
  assert.strictEqual(K.matchAccel('Cmd+A', { metaKey: true, altKey: true, key: 'a' }), false);
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('数字键的 Shift 必须精确声明', () => {
  assert.strictEqual(K.matchAccel('Cmd+1', { metaKey: true, key: '1' }), true);
  assert.strictEqual(K.matchAccel('Cmd+1', { metaKey: true, shiftKey: true, key: '1' }), false);
  assert.strictEqual(K.matchAccel('Shift+Cmd+1', { metaKey: true, shiftKey: true, key: '!' }), false);
  assert.strictEqual(K.matchAccel('Shift+Cmd+1', { metaKey: true, shiftKey: true, key: '1' }), true);
});

// 源自 docs/bugs/0058（Cmd-点击链接不打开）
test('符号键的 Shift 按不按都命中（+ 由字符本身蕴含）', () => {
  assert.strictEqual(K.matchAccel('Cmd++', { metaKey: true, key: '+' }), true);
  assert.strictEqual(K.matchAccel('Cmd++', { metaKey: true, key: '+', shiftKey: true }), true);
  assert.strictEqual(K.matchAccel('Cmd+_', { metaKey: true, key: '_' }), true);
  assert.strictEqual(K.matchAccel('Cmd+_', { metaKey: true, key: '_', shiftKey: true }), true);
});

// 源自 docs/bugs/0058（Cmd-点击链接不打开）
test('修饰键真假用 !! 比对：字段非布尔真值也算按下，但声明里没有就不命中', () => {
  assert.strictEqual(K.matchAccel('Cmd+O', { metaKey: 1, key: 'O' }), true);
  assert.strictEqual(K.matchAccel('Cmd+O', { metaKey: 0, key: 'O' }), false);
});

// 源自 docs/bugs/0058（Cmd-点击链接不打开）
test('事件 key 为空 / accel 为空都不命中', () => {
  assert.strictEqual(K.matchAccel('Cmd+', { metaKey: true, key: '' }), false);
  assert.strictEqual(K.matchAccel('', { metaKey: true, key: 'o' }), false);
  assert.strictEqual(K.matchAccel(null, { key: '' }), false);
});

// ── isOpenGesture / hasModifier / modifiers ──────────────────────

// 源自 docs/bugs/0058（Cmd-点击链接不打开）
test('isOpenGesture：只有 Ctrl 不算打开，⌘/⇧/⌥ 与无修饰都算', () => {
  assert.strictEqual(K.isOpenGesture({ ctrlKey: true }), false);
  assert.strictEqual(K.isOpenGesture({ ctrlKey: false }), true);
  assert.strictEqual(K.isOpenGesture({ metaKey: true }), true);
  assert.strictEqual(K.isOpenGesture({ shiftKey: true }), true);
  assert.strictEqual(K.isOpenGesture({ altKey: true }), true);
  assert.strictEqual(K.isOpenGesture({}), true);
  assert.strictEqual(K.isOpenGesture(null), false);
});

// 源自 docs/bugs/0058（Cmd-点击链接不打开）
test('isOpenGesture 与 hasModifier 是两个问题：带 ⌘ 仍是打开手势', () => {
  const ev = { metaKey: true };
  assert.strictEqual(K.hasModifier(ev), true);
  assert.strictEqual(K.isOpenGesture(ev), true);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('hasModifier：只认严格 true 的 ⌘ / ⌃ / ⌥，Shift 不算', () => {
  assert.strictEqual(K.hasModifier({ metaKey: true }), true);
  assert.strictEqual(K.hasModifier({ ctrlKey: true }), true);
  assert.strictEqual(K.hasModifier({ altKey: true }), true);
  assert.strictEqual(K.hasModifier({ shiftKey: true }), false);
  assert.strictEqual(K.hasModifier({ metaKey: 1 }), false);
  assert.strictEqual(K.hasModifier({}), false);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('modifiers：cmd 只认 metaKey，⛔ 不把 ctrl 也算成 cmd', () => {
  assert.deepStrictEqual(K.modifiers({ metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }), {
    cmd: true, ctrl: true, alt: true, shift: true,
  });
  assert.deepStrictEqual(K.modifiers({ ctrlKey: true }), {
    cmd: false, ctrl: true, alt: false, shift: false,
  });
  assert.deepStrictEqual(K.modifiers({ metaKey: 'true' }), {
    cmd: false, ctrl: false, alt: false, shift: false,
  });
});

// ── buildBindings：缺 accel 必须响亮报错 ─────────────────────────

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('web 项缺 accel：报错并跳过，⛔ 不静默留一条只有别名的绑定', () => {
  const r = silence(function () {
    return K.buildBindings([
      { id: 'demo.plain', owner: 'web', accel: '', aliases: ['F2'] },
      { id: 'file.save', owner: 'web', accel: 'Cmd+S' },
    ]);
  });
  assert.deepStrictEqual(r.value, [{ id: 'file.save', accel: 'Cmd+S' }]);
  assert.strictEqual(r.logs.length, 1);
  assert.ok(r.logs[0].indexOf('demo.plain') >= 0);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('aliases 里空串 / null 被跳过，有值的保留顺序', () => {
  const got = K.buildBindings([
    { id: 'x', owner: 'web', accel: 'Cmd+O', aliases: ['Ctrl+O', '', null, 'Ctrl+Shift+O'] },
  ]);
  assert.deepStrictEqual(got.map(function (b) { return b.accel; }),
    ['Cmd+O', 'Ctrl+O', 'Ctrl+Shift+O']);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('owner 大小写敏感：Web / WEB 都不收（后端契约是 web）', () => {
  assert.deepStrictEqual(K.buildBindings([
    { id: 'a', owner: 'Web', accel: 'Cmd+A' },
    { id: 'b', owner: 'web', accel: 'Cmd+B' },
  ]), [{ id: 'b', accel: 'Cmd+B' }]);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('缺 id 的 web 行仍会生成绑定（现状如此）', () => {
  // ⚠️ 疑似缺陷：id 为 undefined 的绑定会进匹配表，命中后 dispatch 找不到动作。
  const got = K.buildBindings([{ owner: 'web', accel: 'Cmd+9' }]);
  assert.deepStrictEqual(got, [{ id: undefined, accel: 'Cmd+9' }]);
});

// ── 快捷键冲突：先到先得 ─────────────────────────────────────────

// 源自 docs/bugs/0058（Cmd-点击链接不打开）
test('同一 accel 出现在两行时，matchEvent 返回表中的第一行', () => {
  const bindings = [
    { id: 'first', accel: 'Cmd+K' },
    { id: 'second', accel: 'Cmd+K' },
  ];
  assert.strictEqual(K.matchEvent(bindings, { metaKey: true, key: 'k' }), 'first');
});

// 源自 docs/bugs/0058（Cmd-点击链接不打开）
test('别名与规范键冲突时同样按绑定顺序取第一个', () => {
  const bindings = [
    { id: 'alias-owner', accel: 'Ctrl+A' },
    { id: 'canonical-owner', accel: 'Ctrl+A' },
  ];
  assert.strictEqual(K.matchEvent(bindings, { ctrlKey: true, key: 'a' }), 'alias-owner');
  assert.strictEqual(K.matchEvent(bindings, { metaKey: true, key: 'a' }), null);
});

// ── dispatch：两条来源与两道闸 ──────────────────────────────────

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('dispatch：表外 id 响亮报错并返回 false', () => {
  const km = makeKm({ table: [{ id: 'known' }] });
  const r = silence(function () { return km.dispatch('unknown', 'key'); });
  assert.strictEqual(r.value, false);
  assert.strictEqual(r.logs.length, 1);
  assert.ok(r.logs[0].indexOf('unknown') >= 0);
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('dispatch：表里有但没接 handler 也报错', () => {
  const km = makeKm({ table: [{ id: 'known' }] });
  const r = silence(function () { return km.dispatch('known', 'menu'); });
  assert.strictEqual(r.value, false);
  assert.ok(r.logs[0].indexOf('没有 handler') >= 0);
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('dispatch：handler 收到 {id, source}；来源只认 menu，其余归 key', () => {
  const km = makeKm({ table: [{ id: 'a' }] });
  const seen = [];
  km.register('a', function (arg) { seen.push(arg); });
  assert.strictEqual(km.dispatch('a', 'menu'), true);
  assert.strictEqual(km.dispatch('a', 'MENU'), true);
  assert.strictEqual(km.dispatch('a', undefined), true);
  assert.deepStrictEqual(seen.map(function (x) { return x.source; }), ['menu', 'key', 'key']);
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('dispatch：组合态挡键盘与菜单两条来源，handler 一次都不跑', () => {
  const km = makeKm({
    table: [{ id: 'a' }],
    ctx: { compositionActive: function () { return true; }, editable: function () { return false; } },
  });
  let called = 0;
  km.register('a', function () { called += 1; });
  assert.strictEqual(km.dispatch('a', 'key'), false);
  assert.strictEqual(km.dispatch('a', 'menu'), false);
  assert.strictEqual(called, 0);
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('dispatch：可编辑焦点同样挡两条来源', () => {
  const km = makeKm({
    table: [{ id: 'a' }],
    ctx: { compositionActive: function () { return false; }, editable: function () { return true; } },
  });
  let called = 0;
  km.register('a', function () { called += 1; });
  assert.strictEqual(km.dispatch('a', 'key'), false);
  assert.strictEqual(km.dispatch('a', 'menu'), false);
  assert.strictEqual(called, 0);
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('register 的退订函数删除 handler，重复退订安全；可重新注册', () => {
  const km = makeKm({ table: [{ id: 'a' }] });
  let n = 0;
  const off = km.register('a', function () { n += 1; });
  km.dispatch('a', 'key');
  off();
  silence(function () { km.dispatch('a', 'key'); });
  off();
  assert.strictEqual(n, 1);
  km.register('a', function () { n += 1; });
  km.dispatch('a', 'key');
  assert.strictEqual(n, 2);
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('handler 自己抛错会原样传出（dispatch 不吞）', () => {
  const km = makeKm({ table: [{ id: 'a' }] });
  km.register('a', function () { throw new Error('动作坏了'); });
  assert.throws(function () { km.dispatch('a', 'key'); }, /动作坏了/);
});

// ── handleKeydown：命中才阻止默认 ───────────────────────────────

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('handleKeydown：命中 ⌘A 时 preventDefault 并执行', () => {
  const km = makeKm({ table: [{ id: 'edit.select-all', owner: 'web', accel: 'Cmd+A' }] });
  let called = 0;
  let prevented = 0;
  km.register('edit.select-all', function () { called += 1; });
  const ok = km.handleKeydown({
    metaKey: true, key: 'a', preventDefault: function () { prevented += 1; },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(called, 1);
  assert.strictEqual(prevented, 1);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('handleKeydown：裸 F2 命中无修饰键的表项（合成夹具，⛔ 不声称真表里还有裸键）', () => {
  const km = makeKm({ table: [{ id: 'demo.plain', owner: 'web', accel: 'F2' }] });
  let called = 0;
  km.register('demo.plain', function () { called += 1; });
  assert.strictEqual(km.handleKeydown({ key: 'F2' }), true);
  assert.strictEqual(called, 1);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('handleKeydown：没命中不动默认动作', () => {
  const km = makeKm({ table: [{ id: 'demo.plain', owner: 'web', accel: 'F2' }] });
  let prevented = 0;
  assert.strictEqual(km.handleKeydown({ key: 'F3', preventDefault: function () { prevented += 1; } }), false);
  assert.strictEqual(prevented, 0);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('handleKeydown：事件缺 preventDefault 时照常分发，⛔ 不抛', () => {
  const km = makeKm({ table: [{ id: 'demo.plain', owner: 'web', accel: 'F2' }] });
  let called = 0;
  km.register('demo.plain', function () { called += 1; });
  assert.doesNotThrow(function () { km.handleKeydown({ key: 'F2' }); });
  assert.strictEqual(called, 1);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('handleKeydown：组合态（isComposing / keyCode 229 / 全局标记）一律不命中', () => {
  const km = makeKm({ table: [{ id: 'demo.plain', owner: 'web', accel: 'F2' }] });
  let called = 0;
  km.register('demo.plain', function () { called += 1; });
  km.handleKeydown({ key: 'F2', isComposing: true });
  km.handleKeydown({ key: 'F2', keyCode: 229 });
  km.composition.active = true;
  km.handleKeydown({ key: 'F2' });
  assert.strictEqual(called, 0);
  km.composition.active = false;
  km.handleKeydown({ key: 'F2' });
  assert.strictEqual(called, 1);
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('handleKeydown：可编辑焦点时不命中，也不 preventDefault', () => {
  const km = makeKm({
    table: [{ id: 'edit.select-all', owner: 'web', accel: 'Cmd+A' }],
    ctx: { compositionActive: function () { return false; }, editable: function () { return true; } },
  });
  let prevented = 0;
  const ok = km.handleKeydown({
    metaKey: true, key: 'a', preventDefault: function () { prevented += 1; },
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(prevented, 0);
});

// 源自 docs/bugs/0036（Cmd-A-全选选中了侧边栏与顶栏）
test('handleKeydown：命中后 dispatch 又因组合态拒绝时，preventDefault 已经发生', () => {
  // ⚠️ 疑似缺陷：两道闸只在开头查一次；若状态在中间翻转，默认动作仍会被阻止。
  let compose = false;
  const km = makeKm({
    table: [{ id: 'a', owner: 'web', accel: 'Cmd+A' }],
    ctx: {
      compositionActive: function () { return compose; },
      editable: function () { return false; },
    },
  });
  km.register('a', function () {});
  let prevented = 0;
  const ev = {
    metaKey: true, key: 'a',
    preventDefault: function () {
      prevented += 1;
      compose = true; // 模拟状态在阻止默认之后翻转
    },
  };
  assert.strictEqual(km.handleKeydown(ev), false);
  assert.strictEqual(prevented, 1);
});

// ── attach / detach ─────────────────────────────────────────────

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('attach 挂三个监听；重复 attach 不重复挂', () => {
  const added = [];
  const win = {
    addEventListener: function (n) { added.push(n); },
    removeEventListener: function () {},
  };
  const km = makeKm({ win: win });
  km.attach();
  km.attach();
  assert.deepStrictEqual(added, ['keydown', 'compositionstart', 'compositionend']);
  assert.strictEqual(win.__rmdKeymapAttached, true);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('attach 返回的 detach 解绑三条并复位标记；再调安全', () => {
  const removed = [];
  const win = {
    addEventListener: function () {},
    removeEventListener: function (n) { removed.push(n); },
  };
  const km = makeKm({ win: win });
  const detach = km.attach();
  detach();
  assert.deepStrictEqual(removed, ['keydown', 'compositionstart', 'compositionend']);
  assert.strictEqual(win.__rmdKeymapAttached, false);
  detach();
  assert.strictEqual(removed.length, 3);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('外部已置 __rmdKeymapAttached 时不再挂监听，detach 仍可安全调用', () => {
  let added = 0;
  const win = {
    __rmdKeymapAttached: true,
    addEventListener: function () { added += 1; },
    removeEventListener: function () {},
  };
  const km = makeKm({ win: win });
  const detach = km.attach();
  assert.strictEqual(added, 0);
  assert.doesNotThrow(function () { detach(); });
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('attach 只查 win 真假：win 缺 addEventListener 时直接抛（现状如此）', () => {
  // ⚠️ 疑似缺陷：守卫 `if (!win) return detach;` 挡不住残缺的 window，
  // 调用方拿到的是 TypeError 而不是可诊断的报错。
  const km = K.createKeymap({ table: [], win: {} });
  assert.throws(function () { km.attach(); }, TypeError);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('compositionstart / end 回调维护全局组合态标记', () => {
  const handlers = {};
  const win = {
    addEventListener: function (n, fn) { handlers[n] = fn; },
    removeEventListener: function () {},
  };
  const km = makeKm({ win: win });
  km.attach();
  handlers.compositionstart();
  assert.strictEqual(km.composition.active, true);
  handlers.compositionend();
  assert.strictEqual(km.composition.active, false);
});

// ── checkActions：缺与多余都要报 ────────────────────────────────

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('checkActions：一一对应时 ok，note 带上表长与 handler 数', () => {
  const km = makeKm({ table: [{ id: 'a' }, { id: 'b' }] });
  km.register('a', function () {});
  km.register('b', function () {});
  const got = km.checkActions();
  assert.deepStrictEqual(got.missing, []);
  assert.deepStrictEqual(got.extra, []);
  assert.strictEqual(got.ok, true);
  assert.ok(got.note.indexOf('2 项') >= 0);
  assert.ok(got.note.indexOf('2 个') >= 0);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('checkActions：表里有、代码没接 ⇒ missing', () => {
  const km = makeKm({ table: [{ id: 'a' }, { id: 'b' }] });
  km.register('a', function () {});
  const got = km.checkActions();
  assert.deepStrictEqual(got.missing, ['b']);
  assert.strictEqual(got.ok, false);
  assert.ok(got.note.indexOf('没有 handler') >= 0);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('checkActions：代码里接了、表里没有 ⇒ extra（迁移漏删的旧绑定）', () => {
  const km = makeKm({ table: [{ id: 'a' }] });
  km.register('a', function () {});
  km.register('old.action', function () {});
  const got = km.checkActions();
  assert.deepStrictEqual(got.extra, ['old.action']);
  assert.strictEqual(got.ok, false);
  assert.ok(got.note.indexOf('迁移漏删') >= 0);
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('checkActions：空表 + 空 handler 也算一一对应', () => {
  const got = makeKm({ table: [] }).checkActions();
  assert.deepStrictEqual(got, { ok: true, missing: [], extra: [], note: '表 0 项 / handler 0 个，一一对应' });
});

// 源自 docs/bugs/0097（裸F2在默认媒体键设置下可能到不了应用）
test('actionIds 只列已注册的动作', () => {
  const km = makeKm({ table: [{ id: 'a' }] });
  assert.deepStrictEqual(km.actionIds(), []);
  km.register('a', function () {});
  assert.deepStrictEqual(km.actionIds(), ['a']);
});
