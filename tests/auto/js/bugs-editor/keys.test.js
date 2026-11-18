// 编辑区按键转发：白名单必须与后端 `SHORTCUTS` 表逐项一致，⛔ 不能有第二份键位表。
// 本文件从 docs/bugs 的历史缺陷出发，守住「编辑区里应用键不能静默失效 / 不能转发错键」。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

/** 与 `tests/js/` 既有做法一致：读源码 → `new Function('window', src)(win)`。 */
function loadWindow(files) {
  const win = {};
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    new Function('window', src)(win);
  }
  return win;
}

const W = loadWindow(['src/services/keymap.js', 'src/editor/keys.js']);
const K = W.rmd.keymap;
const E = W.rmd.editorKeys;

/**
 * ⭐ 从**后端唯一键位表** `src-tauri/src/gui/mod.rs::SHORTCUTS` 现读。
 * ⚠️ 这里刻意不抄一份键位表：抄一份就等于让测试自己变成第二个真相。
 */
function readBackendTable() {
  const src = fs.readFileSync(path.join(ROOT, 'src-tauri/src/gui/mod.rs'), 'utf8');
  const start = src.indexOf('const SHORTCUTS: &[Shortcut] = &[');
  assert.ok(start >= 0, '后端 SHORTCUTS 表不存在——判据已失靶');
  const end = src.indexOf('\n];', start);
  assert.ok(end > start, '后端 SHORTCUTS 表没有闭合——判据已失靶');
  const block = src.slice(start, end);
  const rows = [];
  const re = /Shortcut\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(block))) {
    const body = m[1];
    const id = body.match(/id:\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))/);
    const accel = body.match(/accel:\s*"([^"]*)"/);
    const owner = body.match(/owner:\s*Owner::(Menu|Web)/);
    rows.push({
      id: id ? (id[1] || id[2]) : null,
      accel: accel ? accel[1] : null,
      owner: owner ? owner[1].toLowerCase() : null,
    });
  }
  assert.ok(rows.length >= 20, 'SHORTCUTS 解析结果过少（' + rows.length + ' 条）——解析器可能已漂');
  return rows;
}

const TABLE = readBackendTable();
const WEB_ROWS = TABLE.filter(function (r) { return r.owner === 'web'; });

/** 当前后端表在「编辑态必须转发」的那 30 项（表序，⛔ 不按字母重排）。⚠️ 表变了这里必须跟着审。
 *  ⚠️ 2026-11-16 重新审过一遍：`design/0075`（`edit.replace`）、`0077`（复制五条）、
 *     `0071` 阶段 3/4 与 `0069`/`0057` 的那几条在表里已存在多时，本清单此前停在 20 项。 */
const 应转发的ID = [
  'view.toggle-chrome',
  'file.open',
  'file.open-file',
  'file.new',
  'reader.font-inc',
  'reader.font-dec',
  'reader.font-reset',
  'file.save',
  'edit.toggle',
  'file.open-external-editor',
  'file.quick-open',
  'file.refresh-index',
  'edit.find',
  'edit.replace',
  'edit.find-next',
  'edit.find-prev',
  'edit.select-all',
  'edit.copy-markdown',
  'edit.copy-html',
  'edit.copy-plain',
  'edit.copy-rich',
  'edit.paste-literal',
  'edit.undo',
  'edit.redo',
  'view.start',
  'view.history-back',
  'view.history-forward',
  'file.toggle-favorite',
  'file.export-html',
  'file.export-pdf',
];

function row(id, accel, owner) {
  return { id: id, accel: accel, owner: owner || 'web' };
}

function fakeCM6() {
  const seen = { prec: [], keymapOf: [] };
  return {
    seen: seen,
    Prec: { low: function (x) { seen.prec.push(x); return { low: x }; } },
    keymap: { of: function (list) { seen.keymapOf.push(list); return list; } },
  };
}

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0036（⌘A 全选：有时只选中一个块，有时把侧边栏和顶栏一起选进去）
// ——————————————————————————————————————————————————————————————

test('后端表里 edit.select-all 是 owner=web 的 Cmd+A（⌘A 已有唯一边界）', () => {
  const r = TABLE.find(function (x) { return x.id === 'edit.select-all'; });
  assert.deepStrictEqual(r, { id: 'edit.select-all', accel: 'Cmd+A', owner: 'web' });
});

test('⌘A 必须进转发白名单，否则编辑区会掉回 WebKit 的整页全选', () => {
  const out = E.deriveWhitelist(TABLE);
  const hit = out.specs.find(function (x) { return x.id === 'edit.select-all'; });
  assert.deepStrictEqual(hit, { id: 'edit.select-all', accel: 'Cmd+A', spec: 'Mod-a' });
});

test('⌘A 转发出去的 spec 是 Mod-a，不是别的大小写或符号', () => {
  const hit = E.deriveWhitelist(TABLE).specs.find(function (x) { return x.id === 'edit.select-all'; });
  assert.strictEqual(hit.spec, 'Mod-a');
  assert.strictEqual(hit.spec, hit.spec.toLowerCase().replace('mod', 'Mod'));
});

test('⌘A 不在菜单所有者那一侧：menu 行一条都不能混进 specs', () => {
  const menuIds = TABLE.filter(function (r) { return r.owner === 'menu'; }).map(function (r) { return r.id; });
  const specIds = E.deriveWhitelist(TABLE).specs.map(function (x) { return x.id; });
  for (const id of menuIds) assert.strictEqual(specIds.indexOf(id), -1, id);
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0020（⌘Z 不能撤销编辑）
// ——————————————————————————————————————————————————————————————

test('后端表里 edit.undo / edit.redo 存在且归 web（编辑面自己的历史）', () => {
  const undo = TABLE.find(function (x) { return x.id === 'edit.undo'; });
  const redo = TABLE.find(function (x) { return x.id === 'edit.redo'; });
  assert.deepStrictEqual(undo, { id: 'edit.undo', accel: 'Cmd+Z', owner: 'web' });
  assert.deepStrictEqual(redo, { id: 'edit.redo', accel: 'Shift+Cmd+Z', owner: 'web' });
});

test('⌘Z / ⇧⌘Z 都在转发白名单里，且 spec 正确', () => {
  const out = E.deriveWhitelist(TABLE);
  const undo = out.specs.find(function (x) { return x.id === 'edit.undo'; });
  const redo = out.specs.find(function (x) { return x.id === 'edit.redo'; });
  assert.deepStrictEqual(undo, { id: 'edit.undo', accel: 'Cmd+Z', spec: 'Mod-z' });
  assert.deepStrictEqual(redo, { id: 'edit.redo', accel: 'Shift+Cmd+Z', spec: 'Shift-Mod-z' });
});

test('undo 在 redo 之前（表序即注册序，⛔ 不重排）', () => {
  const ids = E.deriveWhitelist(TABLE).specs.map(function (x) { return x.id; });
  assert.ok(ids.indexOf('edit.undo') < ids.indexOf('edit.redo'));
});

test('⇧⌘Z 与 ⌘Z 是两个不同的 spec，不会互相覆盖', () => {
  const specs = E.deriveWhitelist(TABLE).specs;
  const undo = specs.find(function (x) { return x.id === 'edit.undo'; });
  const redo = specs.find(function (x) { return x.id === 'edit.redo'; });
  assert.notStrictEqual(undo.spec, redo.spec);
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0096（probe-vim-keys 的三条判据漂移与撤销栈状态污染）
//     与 docs/bugs/0097（裸 F2 在 macOS 默认媒体键设置下可能到不了应用）
// ——————————————————————————————————————————————————————————————

test('`view.start` 在后端表里是 `⌘L` / owner=web（2026-11-11 由裸 F2 改来、2026-11-16 定为 ⌘L）', () => {
  const r = TABLE.find(function (x) { return x.id === 'view.start'; });
  assert.deepStrictEqual(r, { id: 'view.start', accel: 'Cmd+L', owner: 'web' });
});

test('`view.start` 含 cmd ⇒ **进**转发白名单（编辑区里不触发靠 dispatch 的 editable 守卫）', () => {
  const out = E.deriveWhitelist(TABLE);
  const spec = out.specs.find(function (x) { return x.id === 'view.start'; });
  assert.ok(spec, '⌘L 含 cmd，派生规则必须把它翻成 CM6 串');
  assert.strictEqual(spec.spec, 'Mod-l', '必须落在 L 键上（CM6 用小写键名）');
  assert.deepStrictEqual(out.skipped, [], '⛔ 没有任何 web 键该被跳过');
});

test('skipped 为空：owner=web 的每一条都真的转发', () => {
  const out = E.deriveWhitelist(TABLE);
  assert.deepStrictEqual(out.skipped.map(function (x) { return x.id; }), []);
});

test('真表现已没有「owner=web 但不带 cmd」的键（改键前那一条是 `view.start` 的 F2）', () => {
  const noCmd = WEB_ROWS.filter(function (r) { return !K.splitAccel(r.accel).mods.includes('cmd'); });
  assert.deepStrictEqual(noCmd.map(function (r) { return r.id; }), []);
});

test('即使把 `view.start` 从表里删掉，白名单也不多一项、也不少一项', () => {
  const 无start = TABLE.filter(function (r) { return r.id !== 'view.start'; });
  const out = E.deriveWhitelist(无start);
  assert.deepStrictEqual(out.skipped, []);
  assert.deepStrictEqual(
    out.specs.map(function (x) { return x.id; }),
    应转发的ID.filter(function (id) { return id !== 'view.start'; })
  );
});

test('notes 恰好是那 5 条 `⌃⌘` 预留项（`design/0079`，⛔ 不进 specs）', () => {
  // ⚠️ 2026-11-16：本条原写「notes 为空」——`0079` 落地后 `⌃⌘` 五条（行号/专注/缩放三键）
  //    开始进 notes，而那份断言没跟着改。现在钉住**集合**，多一条少一条都红。
  const out = E.deriveWhitelist(TABLE);
  assert.deepStrictEqual(out.notes.map(function (x) { return x.id; }), [
    'view.toggle-line-numbers',
    'view.toggle-zen',
    'view.zoom-actual',
    'view.zoom-in',
    'view.zoom-out',
  ]);
  assert.deepStrictEqual(out.notes.map(function (x) { return x.accel; }), [
    'Ctrl+Cmd+L', 'Ctrl+Cmd+Z', 'Ctrl+Cmd+0', 'Ctrl+Cmd+=', 'Ctrl+Cmd+-',
  ]);
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0257（`shortcuts` 缺失被静默替换为 `[]`：空键位表让按键类夹具「按了没反应」且无闸门发现）
// ——————————————————————————————————————————————————————————————

test('空表派生出空 specs（这正是 0257 的静默形态，由自证判据兜底）', () => {
  assert.deepStrictEqual(E.deriveWhitelist([]), { specs: [], skipped: [], notes: [] });
});

test('null / undefined 表同样派生出空 specs，不抛异常', () => {
  assert.deepStrictEqual(E.deriveWhitelist(null), { specs: [], skipped: [], notes: [] });
  assert.deepStrictEqual(E.deriveWhitelist(undefined), { specs: [], skipped: [], notes: [] });
});

test('表为空时 buildBindings 仍装一个空扩展，不返回 undefined', () => {
  const CM6 = fakeCM6();
  const out = E.buildBindings(CM6, E.deriveWhitelist([]).specs, function () { return true; });
  assert.deepStrictEqual(out, { low: [] });
  assert.deepStrictEqual(CM6.seen.prec, [[]]);
});

test('真实表派生出的 specs 非空：空数组只可能是派生写错', () => {
  assert.ok(E.deriveWhitelist(TABLE).specs.length > 0);
});

test('真实表派生的 specs 恰好 30 项（表有变动必须重新审白名单）', () => {
  assert.strictEqual(E.deriveWhitelist(TABLE).specs.length, 30);
});

// ——————————————————————————————————————————————————————————————
// 转发白名单 × 后端表的逐项一致性（三份独立判据）
// ——————————————————————————————————————————————————————————————

test('白名单 id 集合与后端表里「owner=web ∧ 含 cmd」的集合逐项相等', () => {
  // ⚠️ 判据必须与 `deriveWhitelist` 的规则 3 同形：**含 cmd 且不含 ctrl**
  //    （只写"含 cmd"会把 `0079` 的五条 `⌃⌘` 也算进来，而它们刻意不转发）。
  const expect = TABLE
    .filter(function (r) {
      const mods = K.splitAccel(r.accel).mods;
      return r.owner === 'web' && mods.includes('cmd') && !mods.includes('ctrl');
    })
    .map(function (r) { return r.id; });
  assert.deepStrictEqual(E.deriveWhitelist(TABLE).specs.map(function (x) { return x.id; }), expect);
});

test('白名单 id 顺序与后端表顺序一致（⛔ 不按字母重排）', () => {
  // ⚠️ 判据必须与 `deriveWhitelist` 的规则 3 同形：**含 cmd 且不含 ctrl**
  //    （只写"含 cmd"会把 `0079` 的五条 `⌃⌘` 也算进来，而它们刻意不转发）。
  const expect = TABLE
    .filter(function (r) {
      const mods = K.splitAccel(r.accel).mods;
      return r.owner === 'web' && mods.includes('cmd') && !mods.includes('ctrl');
    })
    .map(function (r) { return r.id; });
  assert.deepStrictEqual(E.deriveWhitelist(TABLE).specs.map(function (x) { return x.id; }), 应转发的ID);
  assert.deepStrictEqual(expect, 应转发的ID);
});

test('每一条 spec 都由该行自己的 accel 逐字转换而来（不是另写一份）', () => {
  for (const s of E.deriveWhitelist(TABLE).specs) {
    assert.strictEqual(s.spec, E.toCM6Spec(s.accel), s.id);
  }
});

test('每一条 spec 都含 Mod：编辑态只认 ⌘，⛔ 不把 ctrl 混进来', () => {
  for (const s of E.deriveWhitelist(TABLE).specs) {
    assert.match(s.spec, /(^|-)(Mod)(-|$)/, s.id);
    assert.strictEqual(/(^|-)(Ctrl)(-|$)/.test(s.spec), false, s.id);
  }
});

test('spec 的键名部分不出现大写字母：CM6 的 normalizeKeyName 不折小写', () => {
  for (const s of E.deriveWhitelist(TABLE).specs) {
    let key = s.spec;
    while (/^(Mod|Shift|Alt|Ctrl)-/.test(key)) key = key.replace(/^(Mod|Shift|Alt|Ctrl)-/, '');
    assert.strictEqual(key, key.toLowerCase(), s.id + ' → ' + s.spec);
  }
});

test('spec 里不出现 `+` / `_`：那两个键非按 Shift 敲不出来', () => {
  for (const s of E.deriveWhitelist(TABLE).specs) {
    assert.strictEqual(s.spec.includes('+'), false, s.id);
    assert.strictEqual(s.spec.includes('_'), false, s.id);
  }
});

test('白名单里没有重复的 spec（重复会让一条键同时触发两个动作）', () => {
  const specs = E.deriveWhitelist(TABLE).specs.map(function (x) { return x.spec; });
  assert.strictEqual(new Set(specs).size, specs.length);
});

test('白名单里没有重复的 id', () => {
  const ids = E.deriveWhitelist(TABLE).specs.map(function (x) { return x.id; });
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('后端表里每个 accel 自身唯一（否则转发层会撞键）', () => {
  const accels = TABLE.map(function (r) { return r.accel; });
  assert.strictEqual(new Set(accels).size, accels.length);
});

test('字号三键：⌘= / ⌘- / ⌘0 的规范形式都在白名单里（2026-11-16 导航页改用 ⌘L）', () => {
  const specs = E.deriveWhitelist(TABLE).specs;
  assert.strictEqual(specs.find(function (x) { return x.id === 'reader.font-inc'; }).spec, 'Mod-=');
  assert.strictEqual(specs.find(function (x) { return x.id === 'reader.font-dec'; }).spec, 'Mod--');
  assert.strictEqual(specs.find(function (x) { return x.id === 'reader.font-reset'; }).spec, 'Mod-0');
});

test('font-inc / font-dec 的别名 Cmd++ / Cmd+_ 被响亮跳掉，⛔ 不进 specs', () => {
  // 真实表只认规范 accel；这里单独验证「若有人把别名当 accel」的后果。
  const out = E.deriveWhitelist([row('font-inc', 'Cmd++'), row('font-dec', 'Cmd+_')]);
  assert.deepStrictEqual(out.specs, []);
  assert.deepStrictEqual(out.skipped.map(function (x) { return x.id; }), ['font-inc', 'font-dec']);
});

test('保存键（file.save）在白名单里且是 Mod-s：自证判据 ③ 的靶子', () => {
  const hit = E.deriveWhitelist(TABLE).specs.find(function (x) { return x.id === 'file.save'; });
  assert.strictEqual(hit.spec, 'Mod-s');
});

test('白名单里没有裸键：每条都至少带一个 Mod', () => {
  for (const s of E.deriveWhitelist(TABLE).specs) {
    assert.notStrictEqual(s.spec, s.spec.replace('Mod', ''), s.id);
  }
});

test('后端表没有 owner=web 的 ctrl 规范项；将来加了也只进 notes，⛔ 不进 specs', () => {
  const out = E.deriveWhitelist([row('x', 'Ctrl+S'), row('y', 'Cmd+Ctrl+J')]);
  assert.deepStrictEqual(out.specs, []);
  assert.deepStrictEqual(out.notes.map(function (x) { return x.id; }), ['x', 'y']);
});

test('表里未知 owner 一律跳过，不当作 web 转发', () => {
  const out = E.deriveWhitelist([row('x', 'Cmd+S', 'weird'), row('ok', 'Cmd+K', 'web')]);
  assert.deepStrictEqual(out.specs.map(function (x) { return x.id; }), ['ok']);
});

test('owner=web 但没有 accel 的行进 skipped，⛔ 不静默消失', () => {
  const out = E.deriveWhitelist([row('noaccel', '')]);
  assert.deepStrictEqual(out.specs, []);
  assert.match(out.skipped[0].why, /没有 accel/);
});

test('accel 解析不出键名时进 skipped，而不是造一个假串', () => {
  const out = E.deriveWhitelist([row('bad', '   '), row('also-bad', '')]);
  assert.deepStrictEqual(out.specs, []);
  assert.match(out.skipped[0].why, /解析不出键名/);
  assert.match(out.skipped[1].why, /没有 accel/);
});

test('null / 非对象行被安全跳过', () => {
  const out = E.deriveWhitelist([null, {}, row('ok', 'Cmd+S')]);
  assert.deepStrictEqual(out.specs.map(function (x) { return x.id; }), ['ok']);
});

test('表里含 menu 行时 menu 行不消耗 accel 解析、也不进 skipped', () => {
  const out = E.deriveWhitelist([row('m', 'Cmd+Q', 'menu'), row('w', 'Cmd+S', 'web')]);
  assert.deepStrictEqual(out.skipped, []);
  assert.deepStrictEqual(out.notes, []);
  assert.deepStrictEqual(out.specs.map(function (x) { return x.id; }), ['w']);
});

// ——————————————————————————————————————————————————————————————
// toCM6Spec / 免Shift 的边界（转发能不能成立只有这一条判据）
// ——————————————————————————————————————————————————————————————

test('toCM6Spec 对空 / 只有修饰段返回 null', () => {
  assert.strictEqual(E.toCM6Spec(''), null);
  assert.strictEqual(E.toCM6Spec('Cmd'), null);
  assert.strictEqual(E.toCM6Spec(null), null);
});

test('toCM6Spec 把 Cmd / Command 统一成 Mod', () => {
  assert.strictEqual(E.toCM6Spec('Cmd+S'), 'Mod-s');
  assert.strictEqual(E.toCM6Spec('Command+S'), 'Mod-s');
});

test('toCM6Spec 保留尾位的 - 与 =（⌘- / ⌘= 在 CM6 可达）', () => {
  assert.strictEqual(E.toCM6Spec('Cmd+-'), 'Mod--');
  assert.strictEqual(E.toCM6Spec('Cmd+='), 'Mod-=');
});

test('toCM6Spec 对非按 Shift 敲不出的键名返回 null（⛔ 不造假串）', () => {
  assert.strictEqual(E.toCM6Spec('Cmd++'), null);
  assert.strictEqual(E.toCM6Spec('Cmd+_'), null);
  assert.strictEqual(E.toCM6Spec('Cmd+`'), null);
  assert.strictEqual(E.toCM6Spec("Cmd+'"), null);
});

test('修饰键重复时去重，但不改变首次出现的顺序', () => {
  assert.strictEqual(E.toCM6Spec('Cmd+Command+Shift+S'), 'Mod-Shift-s');
  assert.strictEqual(E.toCM6Spec('Shift+Shift+Cmd+Z'), 'Shift-Mod-z');
});

test('免Shift 接受字母数字与不按 Shift 的常用符号', () => {
  for (const ch of ['a', 'z', '0', '9', '-', '=', '[', ']', '\\', ';', ',', '.', '/']) {
    assert.strictEqual(E.免Shift.test(ch), true, ch);
  }
});

test('免Shift 拒绝大写、加号、下划线与反引号（源码级闸门的已知边界）', () => {
  for (const ch of ['A', '+', '_', '`', "'", ' ', '中']) {
    assert.strictEqual(E.免Shift.test(ch), false, ch);
  }
});

// ——————————————————————————————————————————————————————————————
// buildBindings：命中即转发、⛔ 不把键交还浏览器
// ——————————————————————————————————————————————————————————————

test('buildBindings 把每条 spec 原样做成 key，并包进 Prec.low', () => {
  const CM6 = fakeCM6();
  const specs = [{ id: 'save', spec: 'Mod-s' }, { id: 'find', spec: 'Mod-f' }];
  const out = E.buildBindings(CM6, specs, function () { return true; });
  assert.deepStrictEqual(CM6.seen.keymapOf[0].map(function (b) { return b.key; }), ['Mod-s', 'Mod-f']);
  assert.strictEqual(CM6.seen.prec.length, 1);
  assert.strictEqual(out.low, CM6.seen.keymapOf[0]);
});

test('buildBindings 的 run 恒返回 true，即使 forward 说没处理', () => {
  const CM6 = fakeCM6();
  const out = E.buildBindings(CM6, [{ id: 'x', spec: 'Mod-x' }], function () { return false; });
  const bindings = CM6.seen.keymapOf[0];
  assert.strictEqual(bindings[0].run(), true);
});

test('buildBindings 每条 run 只转发一次，转发的是该条自己的 id', () => {
  const CM6 = fakeCM6();
  const calls = [];
  E.buildBindings(CM6, [{ id: 'a', spec: 'Mod-a' }, { id: 'b', spec: 'Mod-b' }], function (id) {
    calls.push(id);
    return true;
  });
  const bindings = CM6.seen.keymapOf[0];
  bindings[1].run();
  assert.deepStrictEqual(calls, ['b']);
  bindings[0].run();
  bindings[0].run();
  assert.deepStrictEqual(calls, ['b', 'a', 'a']);
});

test('buildBindings 对真实表也只在 run 时转发，注册时不触发副作用', () => {
  const CM6 = fakeCM6();
  const calls = [];
  E.buildBindings(CM6, E.deriveWhitelist(TABLE).specs, function (id) {
    calls.push(id);
    return true;
  });
  assert.deepStrictEqual(calls, []);
  CM6.seen.keymapOf[0].forEach(function (b) { b.run(); });
  assert.deepStrictEqual(calls, 应转发的ID);
});

// ——————————————————————————————————————————————————————————————
// createForwardShim：`ctx.editable()` 垫片必须 try/finally 复位
// ——————————————————————————————————————————————————————————————

test('未绑 keymap 时 forward 返回 false 并响亮报错（⛔ 静默吞键）', () => {
  const errors = [];
  const old = console.error;
  console.error = function (m) { errors.push(String(m)); };
  try {
    const shim = E.createForwardShim({ win: W });
    assert.strictEqual(shim.forward('file.save'), false);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /keymap 还没绑上/);
    assert.match(errors[0], /file\.save/);
  } finally {
    console.error = old;
  }
});

test('转发期间 editable() 让路，dispatch 拿到 source=key，结束后复位', () => {
  const oldDoc = W.document;
  W.document = { activeElement: { isContentEditable: true } };
  try {
    const shim = E.createForwardShim({ win: W });
    const seen = [];
    shim.bind({
      composition: { active: false },
      dispatch: function (id, source) {
        seen.push({ id: id, source: source, forwarding: shim.isForwarding(), editable: shim.ctx.editable() });
        return true;
      },
    });
    assert.strictEqual(shim.ctx.editable(), true);
    assert.strictEqual(shim.forward('file.save'), true);
    assert.deepStrictEqual(seen, [{ id: 'file.save', source: 'key', forwarding: true, editable: false }]);
    assert.strictEqual(shim.isForwarding(), false);
    assert.strictEqual(shim.ctx.editable(), true);
  } finally {
    if (oldDoc === undefined) delete W.document; else W.document = oldDoc;
  }
});

test('dispatch 抛错时 forwarding 也复位，异常照常上抛（⛔ 普通输入框里应用键全部复活）', () => {
  const shim = E.createForwardShim({ win: W });
  shim.bind({
    composition: { active: false },
    dispatch: function () { throw new Error('boom'); },
  });
  assert.throws(function () { shim.forward('x'); }, /boom/);
  assert.strictEqual(shim.isForwarding(), false);
});

test('compositionActive 直接读真实 keymap 实例，不另存一份组合态', () => {
  const shim = E.createForwardShim({ win: W });
  const fake = { composition: { active: false }, dispatch: function () { return true; } };
  shim.bind(fake);
  assert.strictEqual(shim.ctx.compositionActive(), false);
  fake.composition.active = true;
  assert.strictEqual(shim.ctx.compositionActive(), true);
  fake.composition.active = false;
  assert.strictEqual(shim.ctx.compositionActive(), false);
});

test('未绑实例时 compositionActive 为 false（绑定前结构上还调不到 dispatch）', () => {
  const shim = E.createForwardShim({ win: W });
  assert.strictEqual(shim.ctx.compositionActive(), false);
});

test('editable 只认 input / textarea / contenteditable', () => {
  const oldDoc = W.document;
  const shim = E.createForwardShim({ win: W });
  try {
    W.document = { activeElement: { tagName: 'INPUT' } };
    assert.strictEqual(shim.ctx.editable(), true);
    W.document = { activeElement: { tagName: 'TEXTAREA' } };
    assert.strictEqual(shim.ctx.editable(), true);
    W.document = { activeElement: { tagName: 'DIV', isContentEditable: true } };
    assert.strictEqual(shim.ctx.editable(), true);
    W.document = { activeElement: { tagName: 'DIV' } };
    assert.strictEqual(shim.ctx.editable(), false);
  } finally {
    if (oldDoc === undefined) delete W.document; else W.document = oldDoc;
  }
});

test('两个垫片实例的 forwarding 互不串台', () => {
  const a = E.createForwardShim({ win: W });
  const b = E.createForwardShim({ win: W });
  a.bind({ composition: { active: false }, dispatch: function () { return true; } });
  b.bind({ composition: { active: false }, dispatch: function () { return true; } });
  // 用 dispatch 内部观察：a 在飞时 b 还没飞。
  let bDuringA = null;
  a.bind({
    composition: { active: false },
    dispatch: function () {
      bDuringA = b.isForwarding();
      return true;
    },
  });
  a.forward('x');
  assert.strictEqual(bDuringA, false);
  assert.strictEqual(a.isForwarding(), false);
});

test('真实后端表派生的 specs 能全部装进 buildBindings，且 run 都吃掉按键', () => {
  const CM6 = fakeCM6();
  const out = E.buildBindings(CM6, E.deriveWhitelist(TABLE).specs, function () { return false; });
  assert.strictEqual(out.low.length, 30, '应转发 30 项（2026-11-11 起含 view.start；`design/0071` 阶段 3 起含 file.new）');
  for (const b of out.low) assert.strictEqual(b.run(), true);
});
