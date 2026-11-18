// keymap 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：accel 切分（照 muda 规则）、修饰键顺序、Shift 的“字符蕴含”判据、
// 事件匹配、可编辑 / 组合态拦截、绑定表派生、分发器两条来源，
// 以及**从 Rust 真表现读**的一致性判据（⛔ 不在测试里另抄一份键位表）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadKeymap() {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'keymap.js'), 'utf8');
  new Function('window', src)(win);
  return win.rmd.keymap;
}

const K = loadKeymap();

/** 从 `gui/mod.rs` 的 `const SHORTCUTS` 现读真表。 */
function readBackendTable() {
  const file = path.join(ROOT, 'src-tauri', 'src', 'gui', 'mod.rs');
  const src = fs.readFileSync(file, 'utf8');
  const head = 'const SHORTCUTS: &[Shortcut] = &[';
  const start = src.indexOf(head);
  assert.ok(start >= 0, '找不到 const SHORTCUTS —— Rust 侧改名了');
  const end = src.indexOf('\n];', start);
  assert.ok(end > start, '找不到 SHORTCUTS 的结尾');
  const seg = src.slice(start + head.length, end);
  const out = [];
  for (const blk of seg.match(/Shortcut\s*\{[\s\S]*?\}/g) || []) {
    const id = /id:\s*"([^"]+)"/.exec(blk);
    const accel = /accel:\s*"([^"]+)"/.exec(blk);
    const owner = /owner:\s*Owner::(Web|Menu|Other)/.exec(blk);
    const aliases = /aliases:\s*&\[([^\]]*)\]/.exec(blk);
    if (!id || !accel || !owner) continue;
    out.push({
      id: id[1],
      accel: accel[1],
      owner: owner[1].toLowerCase(),
      aliases: aliases ? [...aliases[1].matchAll(/"([^"]+)"/g)].map(function (m) { return m[1]; }) : [],
    });
  }
  assert.ok(out.length >= 15, '从 Rust 只读到 ' + out.length + ' 项，解析器跟不上格式了');
  assert.ok(out.some(function (r) { return r.id === 'file.save'; }));
  assert.ok(out.some(function (r) { return r.id === 'edit.find'; }));
  return out;
}

const TABLE = readBackendTable();
const WEB = TABLE.filter(function (r) { return r.owner === 'web'; });

function silenceErrors(fn) {
  const old = console.error;
  const logs = [];
  console.error = function () { logs.push([].slice.call(arguments).join(' ')); };
  try {
    return { value: fn(), logs: logs };
  } finally {
    console.error = old;
  }
}

// ── accel 切分 ────────────────────────────────────────────────────

test('splitAccel：普通 accel 切成修饰段与键名', () => {
  assert.deepStrictEqual(K.splitAccel('Cmd+O'), { mods: ['cmd'], key: 'O' });
  assert.deepStrictEqual(K.splitAccel('Shift+Cmd+O'), { mods: ['shift', 'cmd'], key: 'O' });
});

test('splitAccel：键名本身就是 + 时按 muda 规则单独处理', () => {
  assert.deepStrictEqual(K.splitAccel('Cmd++'), { mods: ['cmd'], key: '+' });
});

test('splitAccel：单符号键名不被当成修饰段', () => {
  assert.deepStrictEqual(K.splitAccel('Cmd+_'), { mods: ['cmd'], key: '_' });
  assert.deepStrictEqual(K.splitAccel('Cmd+,'), { mods: ['cmd'], key: ',' });
});

test('splitAccel：没有修饰键时 mods 为空、键名原样', () => {
  assert.deepStrictEqual(K.splitAccel('F2'), { mods: [], key: 'F2' });
});

test('splitAccel：空输入返回空键名而不是抛', () => {
  assert.deepStrictEqual(K.splitAccel(''), { mods: [], key: '' });
  assert.deepStrictEqual(K.splitAccel(null), { mods: [], key: '' });
  assert.deepStrictEqual(K.splitAccel('   '), { mods: [], key: '' });
});

test('splitAccel：修饰键顺序按原文保留（渲染层再按规定顺序重排）', () => {
  assert.deepStrictEqual(K.splitAccel('Shift+Cmd+O').mods, ['shift', 'cmd']);
  assert.deepStrictEqual(K.splitAccel('Cmd+Shift+O').mods, ['cmd', 'shift']);
});

test('splitAccel：重复修饰键去重、未知修饰键忽略', () => {
  assert.deepStrictEqual(K.splitAccel('Cmd+Cmd+O').mods, ['cmd']);
  assert.deepStrictEqual(K.splitAccel('Hyper+O'), { mods: [], key: 'O' });
});

test('splitAccel：键名两端的空白被裁掉', () => {
  assert.deepStrictEqual(K.splitAccel('Cmd+  O  '), { mods: ['cmd'], key: 'O' });
});

test('splitAccel：修饰段全被吃掉时剩下的 + 仍是键名', () => {
  assert.deepStrictEqual(K.splitAccel('Cmd+'), { mods: ['cmd'], key: '+' });
});

// ── 键名归一与 Shift 蕴含 ────────────────────────────────────────

test('normalizeKey：单个字母折小写，其余原样', () => {
  assert.strictEqual(K.normalizeKey('A'), 'a');
  assert.strictEqual(K.normalizeKey('z'), 'z');
  assert.strictEqual(K.normalizeKey('F2'), 'F2');
  assert.strictEqual(K.normalizeKey('1'), '1');
  assert.strictEqual(K.normalizeKey(null), '');
});

test('isShiftImplied：字母/数字之外都认为 Shift 已被字符蕴含', () => {
  assert.strictEqual(K.isShiftImplied('a'), false);
  assert.strictEqual(K.isShiftImplied('1'), false);
  assert.strictEqual(K.isShiftImplied('A'), false, '大写字母归一后仍是字母');
  assert.strictEqual(K.isShiftImplied('+'), true);
  assert.strictEqual(K.isShiftImplied('_'), true);
  assert.strictEqual(K.isShiftImplied('{'), true);
  assert.strictEqual(K.isShiftImplied(','), true);
  assert.strictEqual(K.isShiftImplied('F2'), true);
});

// ── 事件匹配 ─────────────────────────────────────────────────────

test('matchAccel：修饰键逐项精确比对，Ctrl 与 Cmd 不互认', () => {
  assert.strictEqual(K.matchAccel('Cmd+O', { metaKey: true, key: 'O' }), true);
  assert.strictEqual(K.matchAccel('Cmd+O', { ctrlKey: true, key: 'O' }), false);
  assert.strictEqual(K.matchAccel('Ctrl+O', { ctrlKey: true, key: 'o' }), true);
  assert.strictEqual(K.matchAccel('Ctrl+O', { metaKey: true, key: 'o' }), false);
});

test('matchAccel：字母键的 Shift 必须精确匹配', () => {
  assert.strictEqual(K.matchAccel('Cmd+O', { metaKey: true, key: 'o', shiftKey: true }), false);
  assert.strictEqual(K.matchAccel('Shift+Cmd+O', { metaKey: true, shiftKey: true, key: 'O' }), true);
  assert.strictEqual(K.matchAccel('Shift+Cmd+O', { metaKey: true, key: 'O' }), false);
});

test('matchAccel：符号键的 Shift 由字符本身蕴含（按不按都算）', () => {
  assert.strictEqual(K.matchAccel('Cmd++', { metaKey: true, key: '+', shiftKey: true }), true);
  assert.strictEqual(K.matchAccel('Cmd++', { metaKey: true, key: '+' }), true);
  assert.strictEqual(K.matchAccel('Cmd+,', { metaKey: true, key: ',', shiftKey: true }), true);
});

test('matchAccel：字母大小写不敏感', () => {
  assert.strictEqual(K.matchAccel('Cmd+B', { metaKey: true, key: 'b' }), true);
  assert.strictEqual(K.matchAccel('Cmd+b', { metaKey: true, key: 'B' }), true);
});

test('matchAccel：多按一个修饰键就不算命中', () => {
  assert.strictEqual(K.matchAccel('Cmd+O', { metaKey: true, altKey: true, key: 'O' }), false);
  assert.strictEqual(K.matchAccel('Cmd+O', { key: 'O' }), false);
});

test('matchAccel：空 accel / 空键名一律不命中', () => {
  assert.strictEqual(K.matchAccel('', { metaKey: true, key: 'O' }), false);
  assert.strictEqual(K.matchAccel(null, { metaKey: true, key: 'O' }), false);
});

test('matchAccel：修饰键书写顺序不影响命中', () => {
  const ev = { metaKey: true, shiftKey: true, key: 'O' };
  assert.strictEqual(K.matchAccel('Shift+Cmd+O', ev), true);
  assert.strictEqual(K.matchAccel('Cmd+Shift+O', ev), true);
});

// ── 焦点 / 组合态 / 修饰键判据 ───────────────────────────────────

test('isEditableElement：input / textarea / contenteditable 为真，其余为假', () => {
  assert.strictEqual(K.isEditableElement({ tagName: 'INPUT' }), true);
  assert.strictEqual(K.isEditableElement({ tagName: 'textarea' }), true);
  assert.strictEqual(K.isEditableElement({ isContentEditable: true }), true);
  assert.strictEqual(K.isEditableElement({ tagName: 'DIV' }), false);
  assert.strictEqual(K.isEditableElement({ tagName: 'DIV', isContentEditable: false }), false);
  assert.strictEqual(K.isEditableElement(null), false);
});

test('isComposingEvent：isComposing 与老 WebKit 的 keyCode 229 都算组合态', () => {
  assert.strictEqual(K.isComposingEvent({ isComposing: true }), true);
  assert.strictEqual(K.isComposingEvent({ keyCode: 229 }), true);
  assert.strictEqual(K.isComposingEvent({ isComposing: false, keyCode: 229 }), true);
  assert.strictEqual(K.isComposingEvent({ isComposing: 'true' }), false);
  assert.strictEqual(K.isComposingEvent({}), false);
  assert.strictEqual(K.isComposingEvent(null), false);
});

test('hasModifier：只认 ⌘ / ⌃ / ⌥，Shift 单按不算', () => {
  assert.strictEqual(K.hasModifier({ metaKey: true }), true);
  assert.strictEqual(K.hasModifier({ ctrlKey: true }), true);
  assert.strictEqual(K.hasModifier({ altKey: true }), true);
  assert.strictEqual(K.hasModifier({ shiftKey: true }), false);
  assert.strictEqual(K.hasModifier({}), false);
  assert.strictEqual(K.hasModifier(null), false);
});

test('isOpenGesture：只有 ⌃-点击不算“打开”，其余修饰键都算', () => {
  assert.strictEqual(K.isOpenGesture({ ctrlKey: true }), false);
  assert.strictEqual(K.isOpenGesture({ ctrlKey: false }), true);
  assert.strictEqual(K.isOpenGesture({ metaKey: true }), true);
  assert.strictEqual(K.isOpenGesture({ shiftKey: true }), true);
  assert.strictEqual(K.isOpenGesture({ altKey: true }), true);
  assert.strictEqual(K.isOpenGesture(null), false);
});

test('modifiers：四个字段各自精确映射，缺省为 false', () => {
  assert.deepStrictEqual(K.modifiers({ metaKey: true, shiftKey: true }), {
    cmd: true, ctrl: false, alt: false, shift: true,
  });
  assert.deepStrictEqual(K.modifiers(null), { cmd: false, ctrl: false, alt: false, shift: false });
  assert.strictEqual(K.modifiers({ metaKey: 1 }).cmd, false);
});

// ── 绑定表派生 ───────────────────────────────────────────────────

test('buildBindings：只收 owner=web 的项', () => {
  const got = K.buildBindings([
    { id: 'web', owner: 'web', accel: 'Cmd+A' },
    { id: 'menu', owner: 'menu', accel: 'Cmd+B' },
  ]);
  assert.deepStrictEqual(got, [{ id: 'web', accel: 'Cmd+A' }]);
});

test('buildBindings：别名一并收进，空别名跳过', () => {
  const got = K.buildBindings([
    { id: 'x', owner: 'web', accel: 'Cmd+A', aliases: ['Ctrl+A', '', null] },
  ]);
  assert.deepStrictEqual(got, [
    { id: 'x', accel: 'Cmd+A' },
    { id: 'x', accel: 'Ctrl+A' },
  ]);
});

test('buildBindings：owner=web 却没有 accel 要响亮报错并跳过', () => {
  const r = silenceErrors(function () {
    return K.buildBindings([
      { id: 'broken', owner: 'web', accel: '' },
      { id: 'ok', owner: 'web', accel: 'Cmd+O' },
    ]);
  });
  assert.deepStrictEqual(r.value, [{ id: 'ok', accel: 'Cmd+O' }]);
  assert.strictEqual(r.logs.length, 1);
  assert.ok(r.logs[0].indexOf('broken') >= 0, r.logs[0]);
});

test('buildBindings：null 行与缺 owner 的行被忽略', () => {
  const got = K.buildBindings([null, {}, { id: 'x', accel: 'Cmd+X' }]);
  assert.deepStrictEqual(got, []);
});

test('matchEvent：返回第一个命中的 id，顺序决定优先级', () => {
  const bindings = [
    { id: 'first', accel: 'Cmd+A' },
    { id: 'second', accel: 'Ctrl+A' },
  ];
  assert.strictEqual(K.matchEvent(bindings, { metaKey: true, key: 'a' }), 'first');
  assert.strictEqual(K.matchEvent(bindings, { ctrlKey: true, key: 'a' }), 'second');
  assert.strictEqual(K.matchEvent(bindings, { key: 'a' }), null);
  assert.strictEqual(K.matchEvent([], { metaKey: true, key: 'a' }), null);
});

// ── 分发器 ───────────────────────────────────────────────────────

function makeKm(opts) {
  const o = opts || {};
  return K.createKeymap({
    table: o.table || [{ id: 'a' }, { id: 'b' }],
    win: o.win,
    ctx: o.ctx,
  });
}

test('dispatch：表外的 id 响亮报错并且不执行', () => {
  const km = makeKm();
  const r = silenceErrors(function () { return km.dispatch('nope', 'menu'); });
  assert.strictEqual(r.value, false);
  assert.strictEqual(r.logs.length, 1);
  assert.ok(r.logs[0].indexOf('nope') >= 0);
});

test('dispatch：表里有、代码没接 handler 时返回 false 并报错', () => {
  const km = makeKm();
  const r = silenceErrors(function () { return km.dispatch('a', 'key'); });
  assert.strictEqual(r.value, false);
  assert.ok(r.logs[0].indexOf('没有 handler') >= 0, r.logs[0]);
});

test('dispatch：注册过的 handler 收到 id 与来源，返回 true', () => {
  const km = makeKm();
  const seen = [];
  km.register('a', function (arg) { seen.push(arg); });
  assert.strictEqual(km.dispatch('a', 'key'), true);
  assert.strictEqual(km.dispatch('a', 'menu'), true);
  assert.deepStrictEqual(seen, [
    { id: 'a', source: 'key' },
    { id: 'a', source: 'menu' },
  ]);
});

test('dispatch：未知来源归一成 key', () => {
  const km = makeKm();
  let src = null;
  km.register('a', function (arg) { src = arg.source; });
  km.dispatch('a', 'bogus');
  assert.strictEqual(src, 'key');
});

test('dispatch：组合态挡两条来源', () => {
  const km = makeKm({ ctx: { compositionActive: function () { return true; }, editable: function () { return false; } } });
  let called = 0;
  km.register('a', function () { called += 1; });
  assert.strictEqual(km.dispatch('a', 'key'), false);
  assert.strictEqual(km.dispatch('a', 'menu'), false);
  assert.strictEqual(called, 0);
});

test('dispatch：可编辑焦点挡两条来源', () => {
  const km = makeKm({ ctx: { compositionActive: function () { return false; }, editable: function () { return true; } } });
  let called = 0;
  km.register('a', function () { called += 1; });
  assert.strictEqual(km.dispatch('a', 'key'), false);
  assert.strictEqual(km.dispatch('a', 'menu'), false);
  assert.strictEqual(called, 0);
});

test('handleKeydown：命中才 preventDefault 并执行', () => {
  const km = makeKm({ table: [{ id: 'a', owner: 'web', accel: 'Cmd+A' }] });
  let called = 0;
  let prevented = 0;
  km.register('a', function () { called += 1; });
  const ok = km.handleKeydown({
    metaKey: true, key: 'a',
    preventDefault: function () { prevented += 1; },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(called, 1);
  assert.strictEqual(prevented, 1);
});

test('handleKeydown：没命中时不动默认动作', () => {
  const km = makeKm({ table: [{ id: 'a', owner: 'web', accel: 'Cmd+A' }] });
  let prevented = 0;
  const ok = km.handleKeydown({ key: 'x', preventDefault: function () { prevented += 1; } });
  assert.strictEqual(ok, false);
  assert.strictEqual(prevented, 0);
});

test('handleKeydown：组合态 / 可编辑焦点 / composition 标记都直接返回 false', () => {
  const table = [{ id: 'a', owner: 'web', accel: 'Cmd+A' }];
  let called = 0;
  const register = function (km) { km.register('a', function () { called += 1; }); return km; };
  const ev = { metaKey: true, key: 'a', preventDefault: function () {} };

  register(makeKm({ table: table })).handleKeydown({ metaKey: true, key: 'a', isComposing: true });
  register(makeKm({ table: table })).handleKeydown({ metaKey: true, key: 'a', keyCode: 229 });
  register(makeKm({
    table: table,
    ctx: { compositionActive: function () { return false; }, editable: function () { return true; } },
  })).handleKeydown(ev);
  const km = register(makeKm({ table: table }));
  km.composition.active = true;
  km.handleKeydown(ev);
  assert.strictEqual(called, 0);
});

test('attach / detach：只挂一次监听，解绑后标记复位', () => {
  const added = [];
  const removed = [];
  const win = {
    addEventListener: function (name, fn) { added.push(name); },
    removeEventListener: function (name, fn) { removed.push(name); },
  };
  const km = makeKm({ win: win });
  const detach = km.attach();
  km.attach();
  assert.deepStrictEqual(added, ['keydown', 'compositionstart', 'compositionend']);
  detach();
  assert.deepStrictEqual(removed, ['keydown', 'compositionstart', 'compositionend']);
  assert.strictEqual(win.__rmdKeymapAttached, false);
  detach(); // 幂等
  assert.strictEqual(removed.length, 3);
});

// ── 跨语言一致性（从真表现读）────────────────────────────────────

test('后端真表：每一行的 accel 都能被前端匹配器读懂', () => {
  for (const row of TABLE) {
    const parts = K.splitAccel(row.accel);
    assert.notStrictEqual(parts.key, '', row.id + ' 的 accel 切不出键名：' + row.accel);
    assert.strictEqual(parts.mods.length > 0 || /^[A-Za-z0-9]+$/.test(parts.key), true,
      row.id + ' 的 accel 形状异常：' + row.accel);
  }
});

test('后端真表：别名也都能被前端匹配器读懂', () => {
  for (const row of TABLE) {
    for (const alias of row.aliases) {
      assert.notStrictEqual(K.splitAccel(alias).key, '', row.id + ' 的别名为空：' + alias);
    }
  }
});

test('后端真表：规范 accel 无重复（一个键只归一个动作）', () => {
  const seen = Object.create(null);
  for (const row of TABLE) {
    assert.ok(!seen[row.accel], '重复 accel：' + row.accel + '（' + row.id + ' 与 ' + seen[row.accel] + '）');
    seen[row.accel] = row.id;
  }
});

test('后端真表：menu 与 web 两组的 accel 不重叠', () => {
  const menu = new Set(TABLE.filter(function (r) { return r.owner === 'menu'; }).map(function (r) { return r.accel; }));
  for (const row of WEB) {
    assert.ok(!menu.has(row.accel), '同一 accel 同时属于 menu 与 web：' + row.accel);
  }
});

test('后端真表：buildBindings 收到全部 web 项与别名，丢开 menu', () => {
  const bindings = K.buildBindings(TABLE);
  const expected = [];
  for (const row of WEB) {
    expected.push(row.accel);
    for (const alias of row.aliases) expected.push(alias);
  }
  assert.deepStrictEqual(bindings.map(function (b) { return b.accel; }), expected);
  assert.ok(bindings.every(function (b) { return WEB.some(function (r) { return r.id === b.id; }); }));
});

test('后端真表：没有「不含 cmd」的 web 规范键（2026-11-11 `view.start` 由 F2 改为 ⇧⌘H，2026-11-16 定为 ⌘L）', () => {
  // ⚠️ 改键前这里恰好是 `['view.start']`：裸 F2 不含 cmd，天然落在编辑区转发之外。
  //    用户实机反馈 F2 到不了应用（`bugs/0097`，默认媒体键设置）⇒ 换成 `⇧⌘H`，
  //    于是真表里不再有"不含 cmd"的 web 键。这条断言随表走，⛔ 不是"以后必须有"。
  const noCmd = WEB.filter(function (r) {
    return K.splitAccel(r.accel).mods.indexOf('cmd') < 0;
  }).map(function (r) { return r.id; });
  assert.deepStrictEqual(noCmd, []);
});

test('后端真表：web 的规范 accel 里 ctrl 只能与 cmd 同用（⛔ 没有纯 Ctrl 主键）', () => {
  // ⚠️ 原判据是「规范 accel 不含 ctrl」——`design/0079`（2026-11-15）起它**不再成立**：
  //    行号 / 专注 / 缩放五条按 Mardo 口径落在 `⌃⌘L` `⌃⌘Z` `⌃⌘0` `⌃⌘=` `⌃⌘-`。
  //    ⇒ 判据收紧为「ctrl 必须与 cmd 同用」，守住原本要守的那件事：
  //    ⛔ 不存在**纯 Ctrl** 的应用主键——那会与 Vim 模式 / CM6 / 终端习惯抢键。
  for (const row of WEB) {
    const mods = K.splitAccel(row.accel).mods;
    if (mods.indexOf('ctrl') >= 0) {
      assert.ok(mods.indexOf('cmd') >= 0, row.id + ' 的 accel 是纯 Ctrl 主键：' + row.accel);
    }
  }
});

test('后端真表：每一条 web 绑定都能构造出匹配它的事件', () => {
  for (const row of WEB) {
    for (const seq of [row.accel].concat(row.aliases)) {
      const parts = K.splitAccel(seq);
      const ev = {
        metaKey: parts.mods.indexOf('cmd') >= 0,
        ctrlKey: parts.mods.indexOf('ctrl') >= 0,
        altKey: parts.mods.indexOf('alt') >= 0,
        shiftKey: parts.mods.indexOf('shift') >= 0,
        key: parts.key,
      };
      assert.strictEqual(K.matchAccel(seq, ev), true, row.id + ' 构造事件后仍匹配不上：' + seq);
    }
  }
});
