// `design/0012` §2.3-4 / §2.3-6 的单测：**转发白名单的派生** ＋ `ctx.editable()` 垫片。
//
// ⭐ 为什么这个文件的核心是**变异测试**（§2.3-6 原文点名要的）：
//    §2.3-4 的整条决定是"白名单**派生**自后端那张表，⛔ 不是第二份手写清单"。
//    而"派生对不对"这件事**没法靠正常路径验**——正常路径下派生对了也不会报错，
//    派生**错**了同样不会报错（只有"某个键在编辑区里按不动"这一个表现，
//    而那完全可能被当成"CM6 的锅"）。
//    ⇒ 唯一能证明"它是派生的"的办法是**改输入、看输出跟着变**。
//
// ⚠️⚠️ **表是从 `src-tauri/src/gui/mod.rs` 现读的**，⛔ 不是第三份副本：
//    `keymap.test.js` 里那一份夹具是给**纯逻辑**喂数据的（它自己也写着"别当成互锁"），
//    而这一条测的正是"能不能从**真表**派生"——再复制一份就等于把被测对象换成了副本。
//    ⚠️ 代价：Rust 侧改了格式（换行/加字段）会让解析**少读到几项**，而这是**静默**的
//       ⇒ 下面 `读真表()` 里配了三条自检（项数、必有 id、字段完整率）挡它。
//
// ⚠️ 纯逻辑、无 DOM ⇒ 可 `node --test`。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EK = require('../../src/editor/keys.js');
const K = require('../../src/services/keymap.js');

// ─────────────────────────────────────────────────────────────────────────
// 从 Rust 源码读真表
// ─────────────────────────────────────────────────────────────────────────

const RUST = path.join(__dirname, '..', '..', 'src-tauri', 'src', 'gui', 'mod.rs');

/**
 * ⭐ 从 `gui/mod.rs` 的 `const SHORTCUTS` 里**现读**那张表。
 *
 * ⚠️ **只认字面量**：`id: MENU_SETTINGS_ID` 那两条（`settings.open` /
 *    `view.toggle-sidebar`）的 id 是常量引用，解析不出来 ⇒ 这里得到的是
 *    **Web 那 12 项里能被字面量认出来的那些**。⚠️ 这**够用**：
 *    本文件要断言的对象正是 `owner: Web` 的那一批，而它们的 id **全是字面量**。
 *    ⛔ 不要为了"全覆盖"去 eval Rust 常量——那会把一个纯正则变成半个解释器。
 *
 * @returns {Array<{id:string,accel:string,owner:string}>}
 */
function 读真表() {
  const 全文 = fs.readFileSync(RUST, 'utf8');
  const 起 = 全文.indexOf('const SHORTCUTS: &[Shortcut] = &[');
  assert.ok(起 >= 0, '⛔ 找不到 `const SHORTCUTS` —— Rust 侧改名/换写法了，这条测试的输入变了');
  const 止 = 全文.indexOf('\n];', 起);
  assert.ok(止 > 起, '⛔ 找不到 `SHORTCUTS` 的结尾 `];`');
  const 段 = 全文.slice(起 + 'const SHORTCUTS: &[Shortcut] = &['.length, 止);

  const out = [];
  const 项 = 段.match(/Shortcut\s*\{[\s\S]*?\}/g) || [];
  项.forEach(function (blk) {
    const id = /id:\s*"([^"]+)"/.exec(blk);
    const accel = /accel:\s*"([^"]+)"/.exec(blk);
    const owner = /owner:\s*Owner::(Web|Menu|Other)/.exec(blk);
    if (!id || !accel || !owner) return;
    out.push({ id: id[1], accel: accel[1], owner: owner[1].toLowerCase() });
  });

  // —— 解析自检（⛔ 少了这三条，格式一变就是"静默少测"）——
  assert.ok(out.length >= 12, '⛔ 从 Rust 只读到 ' + out.length + ' 项 —— 解析器跟不上格式了，别把这个数当成"表变小了"');
  assert.ok(
    out.some(function (r) { return r.id === 'file.save'; }),
    '⛔ 读不到 `file.save` —— `design/0012` 加的那一条要么没了、要么解析器没跟上'
  );
  assert.ok(
    out.some(function (r) { return r.id === 'edit.find'; }),
    '⛔ 读不到 `edit.find` —— 解析出来的显然不是那张真表'
  );
  return out;
}

const 真表 = 读真表();

/** 真表里 `owner = web` 的那一批（⭐ 本文件的主角）。 */
const WEB = 真表.filter(function (r) { return r.owner === 'web'; });

// ─────────────────────────────────────────────────────────────────────────
// deriveWhitelist —— 三条判据（§2.3-4）
// ─────────────────────────────────────────────────────────────────────────

test('真表：`owner=web` 的项全部被派生出 CM6 串（没有一项该被 `skipped`）', function () {
  const d = EK.deriveWhitelist(WEB);
  assert.deepStrictEqual(
    d.skipped, [],
    '⛔ 真表里有翻不出 CM6 串的 web 项 —— 那一条在编辑区里**按不动**，而界面上看不出任何异常'
  );
  assert.strictEqual(d.specs.length, WEB.length, '⭐ 真表里每一条 web 键都该有一个 CM6 串');
  // ⚠️ `notes` 也是空的：真表**刻意没有**带 Ctrl 的 `accel`（Ctrl 只在 `aliases` 里）。
  assert.deepStrictEqual(d.notes, [], '⚠️ 真表的 `accel` 里不该出现 ctrl —— 出现就说明决策 3 的预留被动过了');
});

test('真表：`cmd` 项变成 `Mod-`，`shift` 项变成 `Shift-Mod-`（不是 `Mod-Shift-`）', function () {
  const d = EK.deriveWhitelist(WEB);
  const 找 = function (id) {
    const r = d.specs.filter(function (x) { return x.id === id; })[0];
    assert.ok(r, '⛔ 真表里没有 ' + id);
    return r.spec;
  };
  assert.strictEqual(找('file.save'), 'Mod-s');
  assert.strictEqual(找('file.open-directory'), 'Mod-o');
  assert.strictEqual(找('file.open-file'), 'Shift-Mod-o', '⚠️ 顺序无所谓（CM6 会重排），但**必须**是 Shift 那种拼法');
  assert.strictEqual(找('edit.find-prev'), 'Shift-Mod-g');
});

test('⭐ 变异：往表里加一条含 `Cmd` 的项 ⇒ 它**自动**进白名单（⛔ 没人手改过清单）', function () {
  // ⭐ 这一条就是 §2.3-6 要的形态：**改输入、看输出**。
  //    它成立 ⟹ 「白名单是派生的」；它不成立 ⟹ 那里其实是一份手写清单。
  const 前 = EK.deriveWhitelist(WEB);
  const 后 = EK.deriveWhitelist(WEB.concat([{ id: 'future.thing', accel: 'Cmd+K', owner: 'web' }]));
  assert.strictEqual(后.specs.length, 前.specs.length + 1, '⛔ 新加的 `Cmd` 项**必须**自动进来');
  assert.strictEqual(
    后.specs.filter(function (r) { return r.id === 'future.thing'; })[0].spec,
    'Mod-k'
  );
});

test('⭐ 变异：加一条纯 `Ctrl` 的项 ⇒ **不进**白名单，进 `notes`（决策 3 的落点）', function () {
  // ⭐ "预留 Ctrl 组合给将来的 Vim"这句话落到代码上**只有这一个动作**。
  //    ⛔ 如果它进的是 `skipped`，那就被当成缺陷了；它进 `notes`，因为这是**决定**。
  const d = EK.deriveWhitelist([{ id: 'vim.thing', accel: 'Ctrl+X', owner: 'web' }]);
  assert.deepStrictEqual(d.specs, [], '⛔ 带 Ctrl 的项不许转发');
  assert.deepStrictEqual(d.skipped, [], '⚠️ 它不是缺陷 —— ⛔ 别报成该修的项');
  assert.strictEqual(d.notes.length, 1);
  assert.strictEqual(d.notes[0].id, 'vim.thing');
  assert.match(d.notes[0].why, /ctrl/);
});

test('变异：`owner = menu` 的项**不进**白名单（AppKit 处理它，转发只会"收起来又弹回去"）', function () {
  const d = EK.deriveWhitelist([
    { id: 'menu.thing', accel: 'Cmd+M', owner: 'menu' },
    { id: 'web.thing', accel: 'Cmd+M', owner: 'web' },
  ]);
  assert.deepStrictEqual(
    d.specs.map(function (r) { return r.id; }),
    ['web.thing']
  );
  assert.deepStrictEqual(d.skipped, [], '⚠️ Menu 那一条**不是**该报的项，它只是不归我们转发');
});

test('⚠️ 变异：`owner=web` 但不含 `cmd` ⇒ 进 `skipped`（阅读态能按、编辑态按不动 = 分叉）', function () {
  const d = EK.deriveWhitelist([{ id: 'odd.thing', accel: 'F5', owner: 'web' }]);
  assert.deepStrictEqual(d.specs, []);
  assert.strictEqual(d.skipped.length, 1);
  assert.match(d.skipped[0].why, /分叉/, '⭐ 要说清"为什么该报"：这是个**只在两种模式之间存在**的分叉');
});

test('⚠️ 变异：`owner=web` 却没 `accel` ⇒ 进 `skipped`（没有可断言的规范键）', function () {
  const d = EK.deriveWhitelist([{ id: 'odd.thing', accel: '', owner: 'web' }]);
  assert.strictEqual(d.skipped.length, 1);
  assert.match(d.skipped[0].why, /accel/);
});

test('⚠️ 变异：键名"非按 Shift 敲不出来" ⇒ 进 `skipped`，⛔ 不生成一个**看着像**的串', function () {
  // ⚠️ 这是 §2.3-4 那段推理的落点：CM6 的 `keyName()` 在 mac 的 `⌘⇧` 组合下
  //    **整块忽略 `event.key`**，改用"这个物理键不按 Shift 时是什么字符"。
  //    ⇒ 一个非按 Shift 敲不出来的字符，**永远不可能**作为 `Meta-X` 被查到。
  //    ⛔ 而"生成了串、键却按不动"是**静默失效**——必须逐条报出来。
  const d = EK.deriveWhitelist([{ id: 'odd.thing', accel: 'Cmd+{', owner: 'web' }]);
  assert.deepStrictEqual(d.specs, [], '⛔ 不许为 `{` 生成一个永远查不到的串');
  assert.strictEqual(d.skipped.length, 1);
  assert.match(d.skipped[0].why, /Shift/, '⚠️ 要把原因写成人话：这个键名非按 Shift 敲不出来');
});

test('⭐ `免Shift` 的边界（这张字符集是转发成不成立的**唯一**判据）', function () {
  const 应True = ['a', 'z', '0', '9', '-', '=', '[', ']', '\\', ';', ',', '.', '/'];
  应True.forEach(function (c) {
    assert.strictEqual(EK.免Shift.test(c), true, '⛔ 「' + c + '」应当是**不按 Shift 就能敲出来**的字符');
  });
  // ⚠️⚠️ 反引号与单引号**故意不在**集合里，理由写在 `keys.js` 那段：
  //    ① 源码级闸门的 `stripComments` **认不出正则字面量**，类里放裸反引号会让它
  //       从那里起把后面整片当字符串（闸门随即开始误报）；
  //    ② 代价为零且不静默——真被写进 `accel` 时会进 `skipped`，逐条报出来。
  ['`', "'", 'A', '+', '_', '{', '~'].forEach(function (c) {
    assert.strictEqual(EK.免Shift.test(c), false, '⛔ 「' + c + '」不该被判成"不按 Shift 就能敲出来"');
  });
});

test('`toCM6Spec`：大写字母折小写（CM6 的 `normalizeKeyName` ⛔ 不折）', function () {
  assert.strictEqual(EK.toCM6Spec('Cmd+S'), 'Mod-s');
  assert.strictEqual(EK.toCM6Spec('Shift+Cmd+O'), 'Shift-Mod-o');
  assert.strictEqual(EK.toCM6Spec('Cmd+='), 'Mod-=');
  assert.strictEqual(EK.toCM6Spec('Cmd+-'), 'Mod--', '⚠️ 尾部那个 `-` 必须保住：CM6 按 `split(/-(?!$)/)` 切，末位的不切');
  assert.strictEqual(EK.toCM6Spec('Cmd+,'), 'Mod-,');
  assert.strictEqual(EK.toCM6Spec('Cmd+0'), 'Mod-0');
  // ⚠️ 翻不出来的**返回 `null`**（⛔ 不是抛、⛔ 不是返回一个像样的串）。
  assert.strictEqual(EK.toCM6Spec('Cmd++'), null);
  assert.strictEqual(EK.toCM6Spec('Cmd+_'), null);
});

test('`toCM6Spec`：`Ctrl` 翻成 `Ctrl-`（⛔ 不翻成 `Mod-`），而**挡它的是另一道判据**', function () {
  // ⚠️⚠️ 这两件事**必须分开看**（我第一版把它们的判据混在一起，是错的）：
  //    ① `toCM6Spec` 是**纯翻译**：它把 `Ctrl+X` 老老实实翻成 `Ctrl-x`。
  //       ⛔ 翻成 `Mod-x` 才是最坏的写法——用户按 `Ctrl+X` 会触发 `⌘X` 的动作，
  //       而且没有任何地方能看出这件事发生过。
  //    ② 「决策 3 预留 Ctrl 组合」**不在这一层落**，而在 `deriveWhitelist`
  //       那三条判据的第 3 条（下面那条变异测试钉的就是它）。
  //    ⇒ 翻译层保持中立，策略层才做取舍：这样将来真启用 Vim 时，
  //      改的**只有策略那一条**，翻译不用动。
  assert.strictEqual(EK.toCM6Spec('Ctrl+X'), 'Ctrl-x', '⚠️ 翻译层不许夹带策略');
  assert.strictEqual(EK.toCM6Spec('Meta+X'), 'Mod-x', '⚠️ `Meta` 与 `Cmd` 是同一个修饰键的两种拼法');
  // ⭐ 而"实际会发生什么"由策略层决定：
  const d = EK.deriveWhitelist([{ id: 'ctrl.thing', accel: 'Ctrl+X', owner: 'web' }]);
  assert.deepStrictEqual(d.specs, [], '⭐ 策略层把带 Ctrl 的挡在外面（`notes`，不是 `skipped`）');
});

// ─────────────────────────────────────────────────────────────────────────
// buildBindings —— `Prec.low` ＋ `run` 恒 true
// ─────────────────────────────────────────────────────────────────────────

/** 一份最小的 CM6 替身（本文件只需要 `Prec.low` / `keymap.of`）。 */
function 假CM6() {
  return {
    Prec: { low: function (x) { return { 层: 'low', inner: x }; } },
    keymap: { of: function (list) { return { 键: list }; } },
  };
}

test('`buildBindings`：白名单进 `Prec.low`（Vim 插槽留给 `Prec.higher`）', function () {
  const d = EK.deriveWhitelist(WEB);
  const ext = EK.buildBindings(假CM6(), d.specs, function () { return true; });
  assert.strictEqual(ext.层, 'low', '⭐ 应用键必须在**低**优先级：将来 Vim 用 `Prec.higher` 盖在上面');
  assert.strictEqual(ext.inner.键.length, d.specs.length);
  assert.strictEqual(ext.inner.键[0].key, d.specs[0].spec);
});

test('⭐ `buildBindings`：命中一个键就转发**同一个 id**，且 `run` 恒返回 `true`', function () {
  // ⚠️ `run` 恒 `true` 是关键：`keymap.js` 是"命中就 `preventDefault` **再** dispatch"，
  //    所以"handler 不存在"也不该让浏览器接过这个键——否则编辑区里按 `⌘P` 会弹出
  //    WebKit 的打印对话框、`⌘F` 会弹出它自己的查找条（两个浏览器默认行为）。
  const 转发过 = [];
  const ext = EK.buildBindings(假CM6(), [{ id: 'file.save', accel: 'Cmd+S', spec: 'Mod-s' }], function (id) {
    转发过.push(id);
    return true;   // ⚠️ 即便底层说"没执行"，`run` 也必须回 true
  });
  const 条 = ext.inner.键[0];
  assert.strictEqual(条.key, 'Mod-s');
  assert.strictEqual(条.run(), true, '⛔ 必须恒 true');
  assert.deepStrictEqual(转发过, ['file.save'], '⭐ 转发出去的必须是**表里的 id**，⛔ 不是键位串');
});

test('⭐ `buildBindings`：空白名单 ⇒ 一个键都没有（那一形态由自证挡住，⛔ 不在这里兜）', function () {
  const ext = EK.buildBindings(假CM6(), [], function () { return true; });
  assert.deepStrictEqual(ext.inner.键, []);
});

// ─────────────────────────────────────────────────────────────────────────
// 自证第 ③ 项（`edit_ok` 的"转发白名单非空且含保存键"）
// ─────────────────────────────────────────────────────────────────────────

test('⭐ 自证：真表 + 真 bundle 时**必须**过（`edit_ok` 就是它）', function () {
  // ⚠️ 这条把"自证"与"真表"接上了：它是 `FrontendReport.edit_ok` 在 node 侧
  //    唯一能复现的形状（另一侧是 `main.js::runEditSelfTest`，要 WebView）。
  const d = EK.deriveWhitelist(WEB);
  // ⚠️ 第 ① 项（bundle 在）在这里没法真判——`自证` 要一个真 `EditorView`。
  //    ⇒ 本文件只钉第 ③ 项（它的**唯一**判据是"派生结果里有 `Mod-s`"）。
  const 有保存 = d.specs.some(function (r) { return r.spec === 'Mod-s'; });
  assert.ok(有保存, '⛔ 派生结果里没有 `Mod-s` —— 编辑区里 `⌘S` 会按不动，而界面一切正常');
});

test('⚠️ 自证第 ③ 项：`file.save` 的 `accel` 一旦改成不带 cmd ⇒ 它**响亮地**掉出去', function () {
  // ⚠️ 这正是那条判据存在的理由：它挡的是"有人把表里那一行改坏了"，
  //    而改坏的表现在界面上**完全看不出来**（编辑区照样能进、字照样能打）。
  const 坏表 = WEB.map(function (r) {
    return r.id === 'file.save' ? { id: r.id, accel: 'S', owner: r.owner } : r;
  });
  const d = EK.deriveWhitelist(坏表);
  const 有保存 = d.specs.some(function (r) { return r.spec === 'Mod-s'; });
  assert.strictEqual(有保存, false, '⚠️ 前置：改坏之后确实没有了');
  assert.ok(
    d.skipped.some(function (r) { return r.id === 'file.save'; }),
    '⭐ 而且**必须**进 `skipped`（⛔ 不是静默消失）—— 它同时是"派生"与"响亮度"两条要求的交集'
  );
});
