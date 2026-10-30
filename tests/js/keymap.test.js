// `design/0010` §7 的 JS 单测：**快捷键分发器**（`src/services/keymap.js`）。
//
// ⭐ 为什么这一组必须测：`design/0010` 要解决的正是"按键散在三处互不知情的 `keydown` 里"
//    这一族缺陷，而它们**每一条都不报错**：
//
//   ① **别名失效**：`⇧=` 按出来的是 `e.key === '+'` 而**不是** `=`。
//      只按 `accel` 匹配的话，`Cmd++` / `Cmd+_` 这两条**永远匹配不上**，
//      表现是「我一直在用的 `⇧⌘-` 突然不缩小字号了」——没有报错、没有日志。
//   ② **组合态/可编辑焦点只挡了一条路径**：键盘那条挡了、菜单那条没挡，
//      于是"中文输入法组合中从菜单点一下"仍会把侧边栏收起来。
//      ⚠️ 这条恰恰**只有两个来源都测**才看得出来。
//   ③ **迁移漏删**（评审 R1）：旧文件里那段 `keydown` 没删干净 ⇒
//      按键**仍然生效**却**在设置界面里看不见**。所以自检要报"**多余的** handler"。
//
// 跑法：`make test-js`（= `node --test tests/js/`）。
// ⚠️ 放在仓库根的 `tests/js/` 而不是 `src/`：`src/` 是 Tauri 的 `frontendDist`，
//    整个目录**会在编译期嵌进二进制**。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const K = require('../../src/services/keymap.js');

// ────────────────────────────────────────────────────────────────
// 表夹具
// ────────────────────────────────────────────────────────────────

/**
 * ⭐ **一份表夹具**（`design/0010` §7）——`src-tauri/src/gui/mod.rs` 的 `SHORTCUTS`
 * 的**副本**，形状与 `get_shortcuts` 的返回值**逐字段相同**。
 *
 * ⚠️⚠️ **别把它当成"跨语言互锁"**：真正的互锁是**运行时**那一层
 * （`main.js` 拿**后端真表**跑 `keymap.checkActions()`，缺的和多的都报）——
 * 这里复制一份只为了让**纯逻辑**能在 `node --test` 下跑起来（没有 WebView）。
 * 评审 R3 否掉的是"两边各存一份**冻结字面清单**、谁都不真的去比"，
 * 而这里的两份**谁都没被用来互相证明**：夹具只管喂给分发器，真值仍来自 Rust。
 *
 * ⚠️ `owner` 是**小写字符串**（Rust 侧 `ShortcutDto.owner` 给的就是 `"menu"`/`"web"`，
 * 见 `gui/mod.rs` 的 `get_shortcuts`），⛔ 不是枚举名。
 *
 * ⚠️⭐ **`accel` 与 `display` 两份都要有，⛔ 不是重复**（2026-10-14 实施时踩到）：
 * `accel` 是**匹配用**的（`Cmd+O`，匹配器认 `Cmd` 这个词），
 * `display` 是**给人看**的（`⌘O`，`MOD_NAMES` 里**没有** `⌘`）。
 * 只送 `display` 的话这一项**只剩别名**能用——而页面上一切正常。
 * ⇒ `buildBindings` 遇到没 `accel` 的 `web` 项必须**响亮报错**（下面有一条专门测它）。
 */
const TABLE = [
  { id: 'settings.open', label: '设置…', accel: 'Cmd+,', display: '⌘,', owner: 'menu', aliases: [] },
  { id: 'view.toggle-sidebar', label: '显示/隐藏侧边栏', accel: 'Cmd+B', display: '⌘B', owner: 'menu', aliases: [] },
  // ⭐ `design/0037`：`⇧⌘B` 折叠顶栏（`owner: 'web'`、⛔ 不进菜单，与 `⌘E` 同形）。
  { id: 'view.toggle-chrome', label: '显示/隐藏顶栏', accel: 'Shift+Cmd+B', display: '⇧⌘B', owner: 'web', aliases: [] },
  {
    id: 'file.open-directory', label: '打开目录…', accel: 'Cmd+O', display: '⌘O', owner: 'web',
    aliases: ['Ctrl+O'],
  },
  {
    id: 'file.open-file', label: '打开文件…', accel: 'Shift+Cmd+O', display: '⇧⌘O', owner: 'web',
    aliases: ['Shift+Ctrl+O'],
  },
  {
    id: 'reader.font-inc', label: '放大字号', accel: 'Cmd+=', display: '⌘=', owner: 'web',
    aliases: ['Cmd++', 'Ctrl+=', 'Ctrl++'],
  },
  {
    id: 'reader.font-dec', label: '缩小字号', accel: 'Cmd+-', display: '⌘-', owner: 'web',
    aliases: ['Cmd+_', 'Ctrl+-', 'Ctrl+_'],
  },
  {
    id: 'reader.font-reset', label: '复位字号', accel: 'Cmd+0', display: '⌘0', owner: 'web',
    aliases: ['Ctrl+0'],
  },
  // ⭐ `design/0006`（⛔ 夹具里**漏了这两条很久**，2026-10-15 补上）：
  //    它们是 §2.3-4 转发白名单上**最要紧**的两项（`⌘S` 与 `⌘E`），
  //    夹具少两条 ⇒ 上面那些"整表"断言其实一直在**少测两条**，而且**全绿**。
  //    ⚠️ `file.save` **刻意没有** Ctrl 别名（表里其余 `file.*` 都有）。
  { id: 'file.save', label: '保存', accel: 'Cmd+S', display: '⌘S', owner: 'web', aliases: [] },
  // ⭐ `design/0012`：`⌘E` = 进入/退出分栏编辑（2026-10-16 加的**第 15 项**）。
  //    ⚠️ 它与下面 `file.open-external-editor` **换了键**：`⌘E` 原本是外部编辑器的，
  //    现在归它，外部编辑器退到 `⇧⌘E`。两条都仍是 `owner: 'web'` ⇒ 都在
  //    §2.3-4 的转发白名单里（判据 `owner=web ∧ accel 含 cmd ∧ accel 不含 ctrl`）。
  { id: 'edit.toggle', label: '进入/退出编辑', accel: 'Cmd+E', display: '⌘E', owner: 'web', aliases: ['Ctrl+E'] },
  {
    id: 'file.open-external-editor', label: '用外部编辑器打开', accel: 'Shift+Cmd+E', display: '⇧⌘E',
    owner: 'web', aliases: ['Shift+Ctrl+E'],
  },
  // ⭐ `design/0009`：文件名搜索。⚠️ 两条都**归 Web**：
  //    `⌘P` 是浮层的唯一入口；`⌘R` 是浮层的**局部**键（全局那条 handler 是空的，
  //    理由写在 `main.js` 上——`INV-SET-02`② 要的是 handler **存在**）。
  { id: 'file.quick-open', label: '按文件名搜索…', accel: 'Cmd+P', display: '⌘P', owner: 'web', aliases: [] },
  { id: 'file.refresh-index', label: '刷新文件名索引', accel: 'Cmd+R', display: '⌘R', owner: 'web', aliases: [] },
  // ⭐ `design/0011`：正文内查找。⚠️ 三条**都归 Web**，且 `edit.find` **同时**进
  //    `PLAIN_MENU_ITEMS`（Edit 菜单里看得见、**无加速键**——`0006` 的外部编辑器先例）。
  //    ⇒ 「菜单里有没有这一项」与「这个键归谁处理」是**两个维度**（`0010` §9.3 第 2 条）。
  //    ⚠️⚠️ 后两条（`⌘G`/`⇧⌘G`）是**浮层未开时的 no-op**（§9.1 第 5 条）：
  //      全局 handler 在浮层没开时**什么都不做**，浮层开着时由 `FindBar` 本地接——
  //      因为焦点在输入框里时全局分发器被 `ctx.editable()` 整条挡掉了（见下面那条测试）。
  { id: 'edit.find', label: '查找…', accel: 'Cmd+F', display: '⌘F', owner: 'web', aliases: [] },
  { id: 'edit.find-next', label: '查找下一个', accel: 'Cmd+G', display: '⌘G', owner: 'web', aliases: [] },
  { id: 'edit.find-prev', label: '查找上一个', accel: 'Shift+Cmd+G', display: '⇧⌘G', owner: 'web', aliases: [] },
];

/** 全部动作 id（⭐ **含 `owner === 'menu'` 的**——设置界面要列全，§7 步骤 8b）。 */
const ALL_IDS = TABLE.map(function (r) { return r.id; });

/** 只含 `owner === 'web'` 的绑定表（被测代码自己也会算一份，这里留作对照）。 */
const BINDINGS = K.buildBindings(TABLE);

/** 建一个"哑"上下文：组合态与可编辑焦点都由测试直接摆布。 */
function muteCtx(opts) {
  const o = opts || {};
  return {
    compositionActive: function () { return !!o.composing; },
    editable: function () { return !!o.editable; },
  };
}

/** 建一个分发器，并把**全部** id 接上计数桩。返回 `{ km, calls }`。 */
function wired(table, ctx) {
  const t = table || TABLE;
  const km = K.createKeymap({ table: t, win: null, ctx: ctx || muteCtx() });
  const calls = [];
  t.forEach(function (r) {
    km.register(r.id, function (arg) { calls.push({ id: r.id, arg: arg }); });
  });
  return { km: km, calls: calls };
}

/** 一次"按键"。⚠️ `preventDefault` 也记下来——命中才该调（见下）。 */
function key(props) {
  const ev = Object.assign({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, props);
  ev.prevented = false;
  ev.preventDefault = function () { ev.prevented = true; };
  return ev;
}

// ────────────────────────────────────────────────────────────────
// ① 别名匹配
// ────────────────────────────────────────────────────────────────

test('别名_meta 下划线命中缩小字号', function () {
  // ⭐ `⇧⌘-` 按出来的就是这个形状：`key === '_'` 且 `shiftKey === true`。
  //    ⚠️ 若只按 `accel`（`Cmd+-`）匹配，这一下**什么都不会发生**。
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, shiftKey: true, key: '_' })), 'reader.font-dec');
});

test('别名_meta 加号命中放大字号', function () {
  // ⭐ `⇧⌘=` 的形状：`key === '+'`。
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, shiftKey: true, key: '+' })), 'reader.font-inc');
});

test('别名_ctrl 零命中复位字号', function () {
  assert.strictEqual(K.matchEvent(BINDINGS, key({ ctrlKey: true, key: '0' })), 'reader.font-reset');
});

test('裸的减号与等号不命中任何动作', function () {
  // ⛔ 没有修饰键时**一个都不许命中**——否则在正文里按 `-` 就会缩字号。
  assert.strictEqual(K.matchEvent(BINDINGS, key({ key: '-' })), null);
  assert.strictEqual(K.matchEvent(BINDINGS, key({ key: '=' })), null);
  // ⚠️ `Shift+-`（即 `_`）也不行：别名 `Cmd+_` 里那个 `Cmd` 是**必须**的。
  assert.strictEqual(K.matchEvent(BINDINGS, key({ shiftKey: true, key: '_' })), null);
});

test('规范形式本身就命中_不是只靠别名', function () {
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, key: 'o' })), 'file.open-directory');
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, key: '-' })), 'reader.font-dec');
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, key: '=' })), 'reader.font-inc');
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, key: '0' })), 'reader.font-reset');
});

test('Shift 是精确的_不大于也不小于', function () {
  // ⭐ `⇧⌘O` 归 `file.open-file`，⛔ **不许**顺带触发 `file.open-directory`
  //    ——一个键两个动作正是 `INV-SET-04` 要守的东西（表现是"开两次对话框"）。
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, shiftKey: true, key: 'O' })), 'file.open-file');
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, key: 'O' })), 'file.open-directory');
  // ⚠️ 大写 `O` 与小写 `o` **是同一个键**（macOS 上 `⌘⇧O` 才给大写，
  //    所以"大写 ⇒ 要 Shift"那种推法是错的，这里靠 `normalizeKey` 折平）。
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, key: 'O' })), 'file.open-directory');
});

test('多按一个修饰键就不命中', function () {
  // ⚠️ `⌃⌘O` 不是任何一条 —— 别名 `Ctrl+O` 与 `Cmd+O` 是**两条**，⛔ 不是"cmd 或 ctrl"。
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, ctrlKey: true, key: 'o' })), null);
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, altKey: true, key: 'o' })), null);
});

test('菜单自己的键不在绑定表里', function () {
  // ⭐ `⌘B` / `⌘,` 归菜单（`owner === 'menu'`）⇒ `buildBindings` **不产出**它们。
  //    ⛔ 若这里命中了，两面都会响应同一个键（`INV-SET-04` 的"重叠"）。
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, key: 'b' })), null);
  assert.strictEqual(K.matchEvent(BINDINGS, key({ metaKey: true, key: ',' })), null);
});

test('绑定表只含_web_的项_条数对得上', function () {
  const owners = BINDINGS.map(function (b) { return b.id; });
  assert.ok(owners.indexOf('settings.open') < 0);
  assert.ok(owners.indexOf('view.toggle-sidebar') < 0);
  // ⭐ 逐项数：`file.open-directory` 2（accel+1 别名）、`file.open-file` 2、
  //    `reader.font-inc` 4、`reader.font-dec` 4、`reader.font-reset` 2、
  //    ⭐ `file.save` 1（**刻意没有** Ctrl 别名）、
  //    ⭐ `edit.toggle` 2（`accel` ＋ `Ctrl+E` 别名，`design/0012`）、
  //    `file.open-external-editor` 2（`accel` ＋ `Shift+Ctrl+E` 别名）、
  //    ⭐ `file.quick-open` 1、`file.refresh-index` 1（`design/0009`，都无别名）、
  //    ⭐ `edit.find` 1、`edit.find-next` 1、`edit.find-prev` 1（`design/0011`，都无别名）、
  //    ⭐ `view.toggle-chrome` 1（`design/0037`，无别名）⇒ 25。
  //    ⚠️ 别名**不是**等价写法（`Cmd++` 是另一个物理按键），所以它们**必须**各占一条。
  //    ⚠️ 这个数是**算出来的**，不是抄来的：`⌘E`/`⇧⌘E` 那两条 2026-10-16 换过键，
  //       但两者**都带一个别名**，所以总数只因为多了 `edit.toggle` 这一项 **+2**。
  assert.strictEqual(BINDINGS.length, 25);
});

test('每条 accel 与别名都能切出非空的键名', function () {
  // ⚠️ 这是 Rust 侧那条「每个 `accel` 都能被 muda 解析」的**前端对偶**：
  //    切不出键名 ⇒ `matchAccel` 第一行就 `return false` ⇒ **静默**永不命中。
  TABLE.forEach(function (row) {
    const seqs = [row.accel].concat(row.aliases || []).filter(Boolean);
    seqs.forEach(function (seq) {
      const p = K.splitAccel(seq);
      assert.ok(p.key, seq + ' 切不出键名');
      assert.ok(p.mods.length > 0, seq + ' 切不出修饰键');
    });
  });
});

test('accel_是匹配用的_word_形式_不是显示字形', function () {
  // ⚠️⚠️ **这条是 2026-10-14 实施时真踩到的那个坑的回归测试。**
  //    后端一度只送 `display`（`⌘O`），于是这一项**只剩别名**能用：
  //    `Ctrl+O` 能开目录、`⌘O` 按下去**什么都不发生**，而菜单与设置界面里
  //    都明明白白写着 `⌘O`——**没有任何一处报错**。
  //    ⛔ 判据：`accel` 里**不许出现**显示字形（`MOD_NAMES` 认不出它们）。
  const GLYPHS = /[⌘⇧⌃⌥]/;
  TABLE.forEach(function (row) {
    assert.ok(!GLYPHS.test(row.accel), row.id + ' 的 accel 用了显示字形：' + row.accel);
    assert.ok(GLYPHS.test(row.display), row.id + ' 的 display 里没有修饰键字形：' + row.display);
  });
});

test('web_项缺_accel_要响亮报错_不许静默只剩别名', function () {
  // ⭐ 这是上面那个坑在**运行期**的判据：真表若漏了 `accel`，
  //    控制台必须有人喊——⛔ 不许安安静静地只挂上别名。
  const orig = console.error;
  const shouted = [];
  console.error = function () { shouted.push(Array.prototype.join.call(arguments, ' ')); };
  let b;
  try {
    b = K.buildBindings([
      { id: 'file.open-directory', owner: 'web', aliases: ['Ctrl+O'] },        // ⛔ 没有 accel
      { id: 'reader.font-inc', owner: 'web', accel: 'Cmd+=', aliases: [] },     // ✅ 正常
      { id: 'settings.open', owner: 'menu', aliases: [] },                      // ⛔ menu 不管它
    ]);
  } finally {
    console.error = orig;
  }
  assert.strictEqual(shouted.length, 1);
  assert.ok(shouted[0].indexOf('file.open-directory') >= 0);
  assert.ok(shouted[0].indexOf('accel') >= 0);
  // ⚠️ 剩下的那条**照常**挂上——一个坏项不该把整张表废掉。
  assert.deepStrictEqual(b, [{ id: 'reader.font-inc', accel: 'Cmd+=' }]);
});

test('splitAccel 与 muda 的切分规则一致_含加号那一条', function () {
  // ⭐ 对的是 `muda` 的 **`split_key_and_modifiers`**（`rfind('+')` 那一步）。
  //    ⚠️⚠️ 只是**切分**同规则，⛔ 不是"整串能被 muda 解析"——2026-10-14 核实过（`kb/0016` §3）：
  //    `muda` 的**菜单**路径走 `Accelerator`（`Code` 型），`"Cmd++"` / `"Cmd+_"` 在那里是 `Err`。
  //    所以下面这两条断言测的是**前端匹配器自己的切分**（它认 `event.key`，与 `Code` 无关）——
  //    `Cmd++` / `Cmd+_` **只以别名身份存在**，⛔ 从不送去 `muda`（表里那两行的 `accel` 是 `Cmd+=` / `Cmd+-`）。
  assert.deepStrictEqual(K.splitAccel('Cmd++'), { mods: ['cmd'], key: '+' });
  assert.deepStrictEqual(K.splitAccel('Cmd+='), { mods: ['cmd'], key: '=' });
  assert.deepStrictEqual(K.splitAccel('Cmd+_'), { mods: ['cmd'], key: '_' });
  assert.deepStrictEqual(K.splitAccel('Shift+Cmd+O'), { mods: ['shift', 'cmd'], key: 'O' });
  assert.deepStrictEqual(K.splitAccel('Cmd+-'), { mods: ['cmd'], key: '-' });
  assert.deepStrictEqual(K.splitAccel('Cmd+,'), { mods: ['cmd'], key: ',' });
  // ⚠️ 别名写法（`Command` / `Option`）也要认得——表里现在没写，但它是合法输入。
  assert.deepStrictEqual(K.splitAccel('Command+Option+K'), { mods: ['cmd', 'alt'], key: 'K' });
});

test('符号键自己蕴含_Shift_字母数字则不蕴含', function () {
  // ⭐ 这条判据**没有键盘布局表**也成立：比对的是 `e.key` 这个**字符**。
  assert.strictEqual(K.isShiftImplied('_'), true);
  assert.strictEqual(K.isShiftImplied('+'), true);
  assert.strictEqual(K.isShiftImplied('!'), true);
  assert.strictEqual(K.isShiftImplied('o'), false);
  assert.strictEqual(K.isShiftImplied('O'), false);   // ⚠️ 折成小写后仍是字母
  assert.strictEqual(K.isShiftImplied('0'), false);
});

// ────────────────────────────────────────────────────────────────
// ② 组合态：**两条路径都要挡**（`INV-SET-05`）
// ────────────────────────────────────────────────────────────────

test('组合态_键盘路径_isComposing_不执行', function () {
  const w = wired();
  const ev = key({ metaKey: true, key: 'o', isComposing: true });
  assert.strictEqual(w.km.handleKeydown(ev), false);
  assert.strictEqual(w.calls.length, 0);
  // ⚠️ 组合中**不许** `preventDefault`：那是输入法自己的按键。
  assert.strictEqual(ev.prevented, false);
});

test('组合态_键盘路径_keyCode229_不执行', function () {
  // ⚠️ 老 WebKit 只给 `keyCode === 229`、不给 `isComposing`（`0010` §2.1 ⑦）。
  const w = wired();
  const ev = key({ metaKey: true, key: 'o', keyCode: 229 });
  assert.strictEqual(w.km.handleKeydown(ev), false);
  assert.strictEqual(w.calls.length, 0);
});

test('组合态_菜单路径_不执行', function () {
  // ⭐ 菜单点了但输入法正在组合 ⇒ 也**不执行**。
  //    ⚠️ 这条**只有** `composition` 那个全局标记能实现——菜单事件里**没有** `KeyboardEvent`。
  const ctx = muteCtx({ composing: true });
  const w = wired(TABLE, ctx);
  assert.strictEqual(w.km.dispatch('view.toggle-sidebar', 'menu'), false);
  assert.strictEqual(w.calls.length, 0);
  // 组合结束后立刻恢复（⛔ 不是"永久哑掉"）。
  ctx.compositionActive = function () { return false; };
  assert.strictEqual(w.km.dispatch('view.toggle-sidebar', 'menu'), true);
  assert.strictEqual(w.calls.length, 1);
});

test('组合态标记只有一处写入点_且能复位', function () {
  const km = K.createKeymap({ table: TABLE, win: null, ctx: muteCtx() });
  const listeners = Object.create(null);
  const win = {
    addEventListener: function (n, fn) { listeners[n] = fn; },
    removeEventListener: function (n) { delete listeners[n]; },
  };
  const km2 = K.createKeymap({ table: TABLE, win: win, ctx: null });
  km2.attach();
  assert.strictEqual(typeof listeners.compositionstart, 'function');
  assert.strictEqual(typeof listeners.compositionend, 'function');
  listeners.compositionstart();
  assert.strictEqual(km2.composition.active, true);
  listeners.compositionend();
  assert.strictEqual(km2.composition.active, false);
  km2.detach();
  assert.strictEqual(listeners.keydown, undefined);
  assert.ok(km);   // 静音未用告警
});

// ────────────────────────────────────────────────────────────────
// ③ 可编辑焦点：**两条路径都要挡**（`INV-SET-05`）
// ────────────────────────────────────────────────────────────────

test('可编辑焦点_键盘路径_不执行', function () {
  const w = wired(TABLE, muteCtx({ editable: true }));
  assert.strictEqual(w.km.handleKeydown(key({ metaKey: true, key: 'o' })), false);
  assert.strictEqual(w.calls.length, 0);
});

test('可编辑焦点_菜单路径_不执行', function () {
  // ⚠️ 与组合态同理：只挡键盘那条的话，焦点在搜索框里时从菜单点"放大字号"
  //    仍会改字号——"两条路径都要挡"是**同一个**约束，不是两条独立的。
  const w = wired(TABLE, muteCtx({ editable: true }));
  assert.strictEqual(w.km.dispatch('reader.font-inc', 'menu'), false);
  assert.strictEqual(w.calls.length, 0);
});

test('可编辑元素的判据是标签与_contentEditable', function () {
  assert.strictEqual(K.isEditableElement({ tagName: 'INPUT' }), true);
  assert.strictEqual(K.isEditableElement({ tagName: 'TEXTAREA' }), true);
  assert.strictEqual(K.isEditableElement({ tagName: 'DIV', isContentEditable: true }), true);
  assert.strictEqual(K.isEditableElement({ tagName: 'DIV' }), false);
  assert.strictEqual(K.isEditableElement({ tagName: 'BUTTON' }), false);
  assert.strictEqual(K.isEditableElement(null), false);
  // ⚠️ 大小写：`tagName` 在 HTML 里是大写，但 XML 文档里会是小写 —— 两边都认。
  assert.strictEqual(K.isEditableElement({ tagName: 'input' }), true);
});

test('hasModifier_认三个修饰键_不含_Shift_且只认严格_true', function () {
  // ⭐ 它是 `components/ImageViewer.js` 的模态分支（`design/0018` §2.3 ④）用的判据：
  //    "模态开着时**任何**应用快捷键都不许在背后生效"。
  //    ⚠️ 为什么放在这一份：那三个标识符**只许出现在 `keymap.js`**（上面第 184 条闸门）。
  assert.strictEqual(K.hasModifier({ metaKey: true }), true);
  assert.strictEqual(K.hasModifier({ ctrlKey: true }), true);
  assert.strictEqual(K.hasModifier({ altKey: true }), true);
  // ⚠️ `⇧` 单独按**不算**快捷键（与 `splitAccel` / `isShiftImplied` 同口径）——
  //    否则模态里按 `⇧Tab` 与 `⇧+`（也就是 `+`）都会被当成"带修饰键"。
  assert.strictEqual(K.hasModifier({ shiftKey: true }), false);
  assert.strictEqual(K.hasModifier({}), false);
  assert.strictEqual(K.hasModifier(null), false);
  // ⚠️ 严格比较：`=== true`，不是真值判断——`KeyboardEvent` 上这三个成员
  //    本来就只会是布尔，但夹具/旧 WebKit 给 `1` 之类时**不许**被读成"按了 ⌘"。
  assert.strictEqual(K.hasModifier({ metaKey: 1 }), false);
  assert.strictEqual(K.hasModifier({ ctrlKey: 'true' }), false);
});

// ────────────────────────────────────────────────────────────────
// ④ `ACTIONS` 的完备性（`INV-SET-02`）
// ────────────────────────────────────────────────────────────────

test('自检_全接上时通过', function () {
  const w = wired();
  const r = w.km.checkActions();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.extra, []);
  assert.ok(r.note.indexOf(String(TABLE.length)) >= 0);
});

test('自检_缺_handler_要报出来', function () {
  // ⚠️ 这一条防的是"界面上列着一个**按不出来的键**/点下去没反应的菜单项"。
  const km = K.createKeymap({ table: TABLE, win: null, ctx: muteCtx() });
  ALL_IDS.forEach(function (id) {
    if (id !== 'reader.font-reset') km.register(id, function () {});
  });
  const r = km.checkActions();
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.missing, ['reader.font-reset']);
  // ⚠️ 文案要**点到名字**——只说"自检失败"等于没报。
  assert.ok(r.note.indexOf('reader.font-reset') >= 0);
});

test('自检_多余的_handler_也要报出来', function () {
  // ⭐ 评审 R1 那一族：**迁移漏删**（旧文件里那段 `keydown` 没删干净）
  //    ⇒ 键**仍然生效**却**在设置界面里看不见**。⛔ 只报"缺"的话这种最难发现的漏网。
  const w = wired();
  w.km.register('reader.some-removed-action', function () {});
  const r = w.km.checkActions();
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.extra, ['reader.some-removed-action']);
  assert.ok(r.note.indexOf('reader.some-removed-action') >= 0);
});

test('表外的_id_不执行且响亮', function () {
  const w = wired();
  const orig = console.error;
  const shouted = [];
  console.error = function () { shouted.push(Array.prototype.join.call(arguments, ' ')); };
  let ok;
  try {
    ok = w.km.dispatch('reader.does-not-exist', 'menu');
  } finally {
    console.error = orig;
  }
  assert.strictEqual(ok, false);
  assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(shouted.length, 1);
  assert.ok(shouted[0].indexOf('reader.does-not-exist') >= 0);
});

test('表里有 handler 没接_点下去没反应但响亮', function () {
  // ⚠️ 这正是 §6 表里"菜单点下去没反应"的**可诊断形态**：分发明说"没有 handler"。
  const km = K.createKeymap({ table: TABLE, win: null, ctx: muteCtx() });
  const orig = console.error;
  const shouted = [];
  console.error = function () { shouted.push(Array.prototype.join.call(arguments, ' ')); };
  let ok;
  try {
    ok = km.dispatch('settings.open', 'menu');
  } finally {
    console.error = orig;
  }
  assert.strictEqual(ok, false);
  assert.strictEqual(shouted.length, 1);
  assert.ok(shouted[0].indexOf('settings.open') >= 0);
});

test('dispatch 会带上来源_两条路径都到同一个 handler', function () {
  // ⭐ `INV-SET-02`：菜单点击**不走**键绑定，但要走**同一个** `dispatch`。
  const w = wired();
  w.km.handleKeydown(key({ metaKey: true, key: 'o' }));
  w.km.dispatch('file.open-directory', 'menu');
  assert.deepStrictEqual(w.calls.map(function (c) { return c.arg.source; }), ['key', 'menu']);
  assert.deepStrictEqual(w.calls.map(function (c) { return c.arg.id; }), ['file.open-directory', 'file.open-directory']);
});

test('命中才_preventDefault_没命中不动', function () {
  // ⚠️ 提前 `preventDefault` 会让输入框里正常的按键也失效（`keymap.js` 的注释）。
  const w = wired();
  const hit = key({ metaKey: true, key: 'o' });
  w.km.handleKeydown(hit);
  assert.strictEqual(hit.prevented, true);
  const miss = key({ key: 'o' });
  w.km.handleKeydown(miss);
  assert.strictEqual(miss.prevented, false);
});

test('重复_attach_只装一份监听', function () {
  const added = [];
  const win = {
    addEventListener: function (n) { added.push(n); },
    removeEventListener: function () {},
  };
  const km = K.createKeymap({ table: TABLE, win: win, ctx: null });
  km.attach();
  km.attach();
  assert.deepStrictEqual(added, ['keydown', 'compositionstart', 'compositionend']);
});

// ────────────────────────────────────────────────────────────────
// ⑤ 前端源码里**不许出现按键字面量**（`INV-SET-01` 的自动化那一半）
// ────────────────────────────────────────────────────────────────

const SRC = path.join(__dirname, '..', '..', 'src');

/**
 * ⭐ `design/0012` §2.5：`src/vendor/cm6.bundle.js` 是**产物**（`make cm6` 产出，⛔ 不入库）。
 *
 * ⚠️ 必须排除，否则下面那几条源码闸门会被它整片冲红，**而它们每一条都是对的**：
 *    · `ctrlKey` / `metaKey` —— CM6 自己就是**编辑区局部键**的主人
 *      （§2.3-2 的三层归属：编辑器局部键**归 CM6**）；
 *    · `e.key === …` —— 编辑面用的是 CM6 的键盘模型（§2.1① 的扩展白名单）；
 *    · `Cmd+…` 形态的串 —— CM6 内部有 mac 平台分支。
 *
 * ⛔ **只排除这一个文件**，⛔ **不是**整个 `vendor/`：以后若有人往 `src/vendor/` 下写
 *    **自己的**代码，它照样要过这几条闸门。下面「源码自检」那条断言就是钉这件事。
 *
 * ⭐ 至于"这个 bundle 到底是不是我们要的东西"，判据在 `tests/js/cm6-bundle.test.js`：
 *    形态（经典 script / 只有一个全局名）、导出面**恰好**是 §2.1① 那 8 项、
 *    以及 ⭐ `\r` 活不下来（§2.4-5 整段的事实依据）。
 */
const 产物 = new Set(['vendor/cm6.bundle.js']);

/**
 * ⚠️ 判据**只允许**是"相对路径在这一个集合里"，所以单独提出来——
 *    "排除掉整个 `vendor/` 目录"这种写法（`p.includes('vendor')`）会**更省事**、
 *    也**更静默**：它把上面那段注释里承诺的事悄悄作废。
 *    ⇒ 下面「源码自检」拿**诱饵**（`vendor/别的文件.js`）直接问这个函数，
 *    ⛔ 而不是只问"集合里有几项"（那只挡得住改集合、挡不住改判据）。
 */
function 是产物(rel) {
  return 产物.has(rel);
}

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|css|html)$/.test(e.name) && !是产物(path.relative(SRC, p))) out.push(p);
  });
  return out;
}

/**
 * 把注释**挖成空格**（⛔ 不是删掉）——行号必须与原文一一对应，
 * 否则报出来的 `文件:行` 指到别处，等于没报。
 *
 * ⚠️ 为什么注释要豁免：注释里的键位是**文档**，⛔ 不是第二份实现。
 *    `// ⛔ 原来这里写的是 Cmd+O 的 keydown，0010 起已删除` 这种话该能写得出来
 *    ——它解释的正是"这里为什么没有那段代码"。被管的只有**代码**与**用户可见文案**
 *    这两处："用户看到 `⌘O` 而按下去没反应"才是真正的缺陷形态。
 */
function stripComments(text, isHtml) {
  let s = text;
  if (isHtml) s = s.replace(/<!--[\s\S]*?-->/g, function (m) { return m.replace(/[^\n]/g, ' '); });
  let out = '';
  let i = 0;
  let q = null;
  const blank = function (from, to) { out += s.slice(from, to).replace(/[^\n]/g, ' '); };
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '*') {
      const e = s.indexOf('*/', i + 2);
      const end = e < 0 ? s.length : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && n === '/') {
      const e = s.indexOf('\n', i);
      const end = e < 0 ? s.length : e;
      blank(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const FILES = walk(SRC, []).map(function (p) {
  const raw = fs.readFileSync(p, 'utf8');
  return {
    rel: path.relative(SRC, p),
    text: stripComments(raw, /\.html$/.test(p)),
  };
});

test('源码自检_夹具本身没扫到不该扫的东西', function () {
  assert.ok(FILES.length >= 15, '扫到的前端文件太少，路径写错了？');
  assert.ok(FILES.some(function (f) { return f.rel === 'services/keymap.js'; }));

  // ⭐ 排除清单**恰好**是那一个产物。
  assert.deepStrictEqual(
    [...产物].sort(),
    ['vendor/cm6.bundle.js'],
    '⛔ 排除清单被加项了 —— §2.5 只许排这一个**产物**'
  );
  // ⭐ 更关键的一条：拿**诱饵**问判据本身（⛔ 不是问集合里有几项）。
  //    上面那条只挡得住"改集合"，挡不住"改判据"——而后者才是省事的那个写法：
  //    `!p.includes('vendor')` 会让"往 `src/vendor/` 下写**自己的**代码"从这几条闸门
  //    底下溜过去，且**看不出任何异常**（多一个被排除的文件，页面照跑）。
  assert.strictEqual(是产物('vendor/cm6.bundle.js'), true, '产物必须被排除');
  assert.strictEqual(
    是产物('vendor/别的文件.js'),
    false,
    '⛔ 判据把整个 `src/vendor/` 都排掉了 —— 只许排那一个产物文件'
  );
  assert.strictEqual(是产物('editor/main.js'), false, '⛔ 判据排掉了不该排的东西');

  // ⚠️ 反过来也要查：产物**必须真的在**（⛔ 别用"把上面那条排除删掉"来"修"它，
  //    那样只会在别的闸门上换一种方式红）。
  assert.ok(
    fs.existsSync(path.join(SRC, 'vendor', 'cm6.bundle.js')),
    '⛔ 没有 src/vendor/cm6.bundle.js —— 跑 `make cm6`（要 node）'
  );
});

test('修饰键标识符只允许出现在_keymap.js', function () {
  // ⭐ 这是"**第二份绑定表**"的结构性判据：**任何**键绑定都必须写出
  //    `e.metaKey` / `e.ctrlKey` / `e.altKey` 中的一个（`⇧` 单按不构成快捷键）。
  //    ⇒ 这几个标识符**只该出现在唯一那个匹配器里**。
  //    ⚠️ 比"搜 `'b'`"强：搜字面量会被 `title="打开目录 (Cmd+O)"` 这类**人话文案**
  //    误伤（那是给用户看的，⛔ 不是匹配用的），而搜标识符**不会**。
  const BAD = /(metaKey|ctrlKey|altKey|getModifierState)/;
  const hits = [];
  FILES.forEach(function (f) {
    if (f.rel === 'services/keymap.js') return;
    f.text.split('\n').forEach(function (line, i) {
      if (BAD.test(line)) hits.push(f.rel + ':' + (i + 1) + '  ' + line.trim());
    });
  });
  assert.deepStrictEqual(hits, [], '这些地方又出现了一份键绑定：\n' + hits.join('\n'));
});

test('本地按键处理是白名单_新增文件必须说明理由', function () {
  // ⚠️ 下面这几处**不是**快捷键绑定，而是"宿主内的键盘导航"：
  //    · `components/FileTree.js`：树的 ↑↓←→/Home/End/Enter —— 只在树拿到焦点时生效，
  //      是 `aria` 树控件自己的键盘模型（`design/0003`），与全局快捷键无关；
  //    · `components/Settings.js`：`Esc` 关面板 + `Tab` 焦点圈 —— 覆盖层的焦点陷阱
  //      （`INV-SET-07`），同样只在面板开着时生效；
  //    · ⭐ `components/QuickOpen.js`：`Esc` 关浮层、`↑`/`↓` 换选中、`Enter` 打开、
  //      `Tab` 收回输入框 —— 同样是**浮层自己的**键盘模型（`design/0009` §2.1 ④），
  //      只在浮层开着（且它是当刻的焦点主人）时生效。
  //      ⚠️ 关键的一处：它**没有**、也⛔ **不许**在这里判断修饰键——
  //        刷新索引那个键是从后端那张表认出来的（`K.matchEvent`），
  //        上面那条「修饰键标识符只允许出现在 keymap.js」正是它的守卫。
  //    ⭐ `components/FindBar.js`：`Esc` 关浮层、`Enter`/`⇧Enter` 上下一个、
  //      `↑`/`↓` 同上、`Tab` 收回输入框 —— 与 `QuickOpen.js` **同形**的浮层键盘模型
  //      （`design/0011` §2.1 ④）。⭐ 它的本地处理**第一行就是组合态判断**
  //      （`INV-FIND-09`）：中文候选窗开着时 `Enter` 是上屏、↑↓ 是翻候选，
  //      不挡的话"按回车选字"会变成"跳到下一处"。
  //      ⚠️ 同样处：`⌘G`/`⇧⌘G` 是从后端那张表认的（`K.matchEvent`），⛔ 不在这里判修饰键。
  //    ⭐ `components/ImageViewer.js`（`design/0018`）：图片预览层的**模态键盘**
  //      ——`Esc` 关、`+`/`-`/`0`/`1` 缩放、方向键平移、`Tab`/`⇧Tab` 焦点圈、
  //      按钮上的 `Enter`/`Space` 放行、其余一律吞掉（`§2.3 ④`）。⚠️ **它比上面几个更宽**：
  //      它不是"某个控件自己的键盘模型"，而是**打开期间接管整个窗口**（捕获阶段）。
  //      于是它**必须**知道"这个事件带不带修饰键"（模态期间不许 `⌘F`/`⌘E`/`⌘S` 在背后生效）
  //      ——⭐ 但那个判断**不在本文件**：它调 `K.hasModifier(e)`（`services/keymap.js`），
  //      于是那条「修饰键标识符只允许出现在 keymap.js」照旧成立。
  //    ⭐ `main.js`（`design/0026`）：`#doc` 上链接的 **Enter / Space 激活**——
  //      与 `FileTree.js` 的 `Enter` **同族**（"激活当前元素"），只在焦点落在
  //      `<a href>` 上时生效，⛔ 不是全局快捷键。⚠️ 三处纪律都守住了：
  //      组合态先挡（`isComposing`/`keyCode 229`，否则中文上屏的空格会变成"打开链接"）、
  //      修饰键**转调** `K.hasModifier(e)`（上面那条闸门照旧成立）、
  //      而且它是 `#doc` 上的**委托**（正文被整棵替换后不需要重挂）。
  //    ⭐ `services/treerefresh.js`（`design/0034`）：文件树**就地输入行**的
  //      `Enter` 提交 / `Esc` 取消。⚠️ 它是**纯函数**（`inputAction`），不是事件绑定——
  //      `FileTree.js`（已白名单，树的键盘模型）把按键对象递进来判。
  //      ⭐ 它**也必须先挡组合态**（`isComposing` / `keyCode 229`）：中文选词时按回车，
  //      有些 WebKit 版本给的 `e.key` 就是 `Enter` ⇒ 不挡就会提交半截拼音。
  //      ⚠️ 抽到这里的理由与 `services/reload.js` 同族：判据放进 `FileTree.js`
  //      就进不了 `node --test`（那里没有 DOM），而它的错法**全是静默的**。
  //    ⭐ `components/StartScreen.js`（`design/0038`）：启动页的**局部键盘模型**——
  //      `1`–`9` 打开第 n 行、`↑`/`↓` 在行间移焦点（`Enter` 由 `<button>` 原生触发）。
  //      ⚠️ 与 `QuickOpen`/`FileTree` **同族**：它是"屏内自己的键盘模型"，不是全局快捷键，
  //      而且**只在启动页可见期**挂（`main.js::openDocument` 会摘掉）。
  //      ⚠️ 它认的是 `e.key`（`'ArrowDown'`/数字），**不是**应用快捷键；
  //      修饰键一律**转调** `K.hasModifier(e)` ⇒ 上面那条「修饰键标识符只在 keymap.js」照旧成立。
  //      ⭐ 五种放行的判据本体在 `services/start.js::guard`（可单测），
  //      本文件只负责"当场算那五项事实"（⛔ 不在这里另写 `if`）。
  //    ⭐ 白名单**短**才是关键：新加一个文件会让这条测试变红，逼着改的人写清理由。
  //    ⭐ `design/0042`：`components/SidebarSearch.js` 是**常驻输入框自己的**键盘模型
  //      （`↑`/`↓` 在结果里移选中、`Enter` 打开、`Esc` 清空并退出搜索）。
  //      ⚠️ 它**只挂在 `#sidebar-search-input` 上**（⛔ 不是 `document` capture）——
  //      这是常驻控件，用户随时要把焦点移走；它与全局分发器不重叠（输入框有焦点时
  //      全局键本就被"可编辑焦点"判据挡下，`INV-SET-05`）。刷新键仍是**从后端表里认**的。
  //    ⭐ `design/0044`：`components/Sidebar.js` 是**根头那一行自己的**键盘模型
  //      （`Enter` / `Space` / `Shift+F10` 打开根头菜单，`main.js` 只负责接线）。
  //      ⚠️ 它挂在 `#tree-root-header` 上（⛔ 不是 `document`），只有焦点真走到根头才生效；
  //      组合态与修饰键**一律转调** `K.isComposingEvent` / `K.hasModifier` ⇒
  //      上面那条「修饰键标识符只在 keymap.js」照旧成立。
  const ALLOWED = ['components/FileTree.js', 'components/Settings.js', 'components/QuickOpen.js',
    'components/FindBar.js', 'components/ImageViewer.js', 'components/StartScreen.js',
    'components/SidebarSearch.js', 'components/Sidebar.js',
    'services/treerefresh.js', 'main.js'];
  const hits = [];
  FILES.forEach(function (f) {
    if (ALLOWED.indexOf(f.rel) >= 0) return;
    f.text.split('\n').forEach(function (line, i) {
      if (/\.key\s*[!=]==/.test(line)) hits.push(f.rel + ':' + (i + 1) + '  ' + line.trim());
    });
  });
  assert.deepStrictEqual(hits, [], '这些地方在按 `e.key` 做判断，却不白名单里：\n' + hits.join('\n'));
});

test('脚本加载顺序_依赖先于取值', function () {
  // ⭐⭐ **这条是真抓到过一个 bug 的**（2026-10-14，`design/0009` 实施时）。
  //
  // 起因：经典的 `<script>` 是**按顺序执行**的，而这个前端里每个模块的取依赖
  // 都是**加载期取值**（`const S = … : window.rmd.session;`）——⛔ 不是惰性查找。
  // 于是"某个模块排在它依赖的模块之前"这条错**编译不出来、启动也不报**：
  // 那个常量是 `undefined`，只有**第一次真正用到它**时才炸。
  //
  // ⚠️ 实测形态：`search.js` 原本排在 `session.js` **之后** ⇒ 浮层照样打开、
  //    索引照样建（那次是空模式的 `rebuild`，不走 `shouldQuery`），
  //    而**敲下第一个字符**时报
  //    `搜索失败：undefined is not an object (evaluating 'Search.shouldQuery')`。
  //    ⇒ 用一个"看起来完全正常"的浮层骗过了所有路径，只有真打字才露馅。
  //
  // ⭐ 判据用**定义处**（`(window.rmd || (window.rmd = {})).NAME = api`）而不是文件名，
  //    这样以后改文件名/搬模块都不会误报。
  const html = (FILES.find(function (f) { return f.rel === 'index.html'; }) || {}).text || '';
  const order = [];
  const tagRe = /<script\s+src="([^"]+)"/g;
  let m;
  while ((m = tagRe.exec(html))) order.push(m[1]);
  assert.ok(order.length >= 15, 'index.html 里没扫到 script 标签，正则写错了？');
  const at = {};
  order.forEach(function (p, i) { at[p] = i; });

  /** 谁定义了 `window.rmd.NAME`。 */
  const defines = {};
  FILES.forEach(function (f) {
    if (!/\.js$/.test(f.rel)) return;
    const re = /\(window\.rmd \|\| \(window\.rmd = \{\}\)\)\.(\w+)/g;
    let g;
    while ((g = re.exec(f.text))) defines[g[1]] = f.rel;
  });

  const bad = [];
  FILES.forEach(function (f) {
    if (!/\.js$/.test(f.rel)) return;
    const re = /window\.rmd\.(\w+)/g;
    let g;
    while ((g = re.exec(f.text))) {
      const name = g[1];
      const def = defines[name];
      if (!def) { bad.push(f.rel + ' 取用了没人定义的 window.rmd.' + name); continue; }
      if (at[def] === undefined || at[f.rel] === undefined) continue;  // 不在页面里的（不该有）
      if (at[def] > at[f.rel]) {
        bad.push(f.rel + ' 排在 ' + def + ' 之前，却取了 window.rmd.' + name);
      }
    }
  });
  assert.deepStrictEqual(bad, [], '加载顺序错了（取值时那个常量会是 undefined）：\n' + bad.join('\n'));
});

// ────────────────────────────────────────────────────────────────
// ⑦ `design/0012` §7 步骤 0 那三条源码级闸门（⭐ 编辑面的**白名单**守卫）
// ────────────────────────────────────────────────────────────────

// ⚠️ 这三条与上面那四条**同一条纪律**（`0009`/`0010`/`0011` 的先例）：
//    它们守的是"**加了一项，页面上看不出来**"那一类缺陷——§2.1① 的扩展白名单
//    是**封闭**的，而多装一个 `ViewPlugin` 只会让"编辑面里能发生什么"悄悄变宽，
//    ⛔ 不报错、⛔ 没有任何可见变化。

// ⚠️ 两张清单**范围不同**，照 §7 那两条的字面：① 只管 `src/editor/**`（渲染类扩展只可能
//    装在编辑面里），② 管**整个 `src/**`**（键位类只要**被 import 进来**就已经晚了——
//    哪怕它被装在一个不在 `editor/` 下的文件里）。
/** ① §2.1① 表里的**渲染类**：本设计里 CM6 **只是源码编辑器**（预览整份由 Rust/comrak 产出，`adr/0003`）。 */
const CM6_禁装渲染 = ['Decoration', 'ViewPlugin', 'widget'];
/** ② §2.1① 表里的**键位类** ＋ 那个"省事写法"。⛔ 装了会与 §2.3-3 的有序转发链**抢优先级**。 */
const CM6_禁装键位 = ['defaultKeymap', 'standardKeymap', 'emacsStyleKeymap', 'basicSetup'];

/**
 * ⚠️ 两个**只列名字、不认注释**的裸判据（闸门里用的是 `FILES` —— 已 strip 注释）。
 * ⚠️ 之所以要把它抽出来，是为了让下面那条"闸门本身是活的"能**拿诱饵问它**
 *    （只断言"现在零命中"挡不住判据被改窄：有人把范围过滤成只扫 `editor/main.js`，
 *    于是 `keys.js` 那一片从此不受管，而闸门**照样全绿**）。
 */
function 命中(rel, text, names) {
  const hits = [];
  text.split('\n').forEach(function (line, i) {
    names.forEach(function (name) {
      if (new RegExp('\\b' + name + '\\b').test(line)) {
        hits.push(rel + ':' + (i + 1) + '  ' + name + '  ← ' + line.trim());
      }
    });
  });
  return hits;
}

test('⭐ 闸门 ①：`src/editor/**` 的**代码**里不出现渲染类扩展（`Decoration` / `ViewPlugin` / `widget`）', function () {
  const hits = [];
  FILES.forEach(function (f) {
    if (f.rel.indexOf('editor/') !== 0) return;
    hits.push.apply(hits, 命中(f.rel, f.text, CM6_禁装渲染));
  });
  assert.deepStrictEqual(
    hits, [],
    '⛔ 编辑面里出现了 §2.1① 白名单**之外**的扩展（加一项就是改设计）：\n' + hits.join('\n')
  );
});

test('⭐ 闸门 ②：整个 `src/**` 里不出现键位类默认表（`defaultKeymap` / `standardKeymap` / `emacsStyleKeymap` / `basicSetup`）', function () {
  const hits = [];
  FILES.forEach(function (f) {
    hits.push.apply(hits, 命中(f.rel, f.text, CM6_禁装键位));
  });
  assert.deepStrictEqual(
    hits, [],
    '⛔ 装了 CM6 的默认键位 —— 它会接走 §2.3-3 那条有序转发链上游的键：\n' + hits.join('\n')
  );
});

test('⚠️ 上面那两条闸门本身是活的（拿诱饵问判据，⛔ 不是问集合里有几项）', function () {
  // ⚠️ 与 `是产物()` 那条同一条纪律。
  assert.strictEqual(命中('editor/keys.js', 'const x = CM6.basicSetup;', CM6_禁装键位).length, 1,
    '⛔ 判据 ② 认不出 `basicSetup`');
  assert.strictEqual(命中('editor/main.js', 'CM6.defaultKeymap', CM6_禁装键位).length, 1,
    '⛔ 判据 ② 认不出 `defaultKeymap`');
  assert.strictEqual(命中('editor/main.js', 'CM6.Decoration.none', CM6_禁装渲染).length, 1,
    '⛔ 判据 ① 认不出 `Decoration`');
  assert.strictEqual(命中('editor/main.js', 'new ViewPlugin(…)', CM6_禁装渲染).length, 1,
    '⛔ 判据 ① 认不出 `ViewPlugin`');
  // ⚠️ 裸判据**会**命中注释里提名字——那**正是**它和真闸门的差别（真闸门扫的是
  //    `FILES`，注释已被 `stripComments` 挖成空格）。本文件与 `keys.js` 的文档里
  //    到处都是这些名字，那是在**解释**它们为什么不装（`INV-SET-01`：注释是文档，不是第二份实现）。
  assert.strictEqual(命中('editor/main.js', '// 这是 Decoration，不装', CM6_禁装渲染).length, 1,
    '⚠️ 这一条**故意的** —— 它证明"裸判据"与"闸门"的差别就在这里');
  // ⭐ 而真闸门扫的那几张表里，这几个名字**一个都不该有**（否则说明 strip 失败了，
  //    上面两条就会变成"永远全绿"的空闸门）。
  // ⚠️ `src/live/**` 是**第二个** `EditorView`（`design/0047` 的覆盖层），它有自己那份
  //    **独立封闭**的白名单（`INV-LIVE-11` ②）：`StateField` / `Decoration` / `WidgetType`
  //    是**允许**的 ⇒ 这里只把它仍**不许**的三样留着（`ViewPlugin` 一用就整块白屏）。
  FILES.forEach(function (f) {
    const names =
      f.rel.indexOf('live/') === 0
        ? ['ViewPlugin', 'defaultKeymap', 'basicSetup']
        : ['Decoration', 'ViewPlugin', 'defaultKeymap', 'basicSetup'];
    names.forEach(function (name) {
      assert.strictEqual(
        f.text.indexOf(name) >= 0, false,
        '⛔ ' + f.rel + ' 的**代码**里还有 ' + name + ' —— 注释应当已被 `stripComments` 挖空'
      );
    });
  });
  assert.ok(
    FILES.some(function (f) { return f.rel === 'editor/main.js'; }) &&
    FILES.some(function (f) { return f.rel === 'editor/keys.js'; }),
    '⛔ 扫到的 `editor/**` 太少 —— 路径写错了'
  );
});

// ── `design/0052` / `adr/0013`：CM6 导出面的**两栏**（闸门 ③ 的判据表）──────────────

const ENTRY_MJS = path.join(__dirname, '..', '..', 'tools', 'cm6', 'entry.mjs');
const DOCS_DIR = path.join(__dirname, '..', '..', 'docs');
const DESIGN_0052 = path.join(
  DOCS_DIR, 'design', '0052-编辑内核职责重划与能力矩阵.md'
);

/**
 * ⭐ **A · 文档语义面**：事务与状态、选区、历史、语法树、**不绑定键位**的命令。
 * ⚠️ 这条表的每一格都要能回答"它让**文档状态**更正确吗？"——答不上的就是 B 栏。
 */
const A栏 = {
  '@codemirror/state': ['EditorState', 'Compartment', 'StateField', 'EditorSelection'],
  '@codemirror/view': ['Decoration', 'WidgetType'],
  '@codemirror/commands': [
    'history', 'undo', 'redo', 'undoDepth', 'redoDepth', 'isolateHistory',
    'deleteCharBackward', 'deleteCharForward', 'deleteGroupBackward',
    'insertNewline', 'insertBlankLine', 'selectAll',
  ],
  '@codemirror/language': ['syntaxTree', 'ensureSyntaxTree', 'syntaxTreeAvailable'],
  '@codemirror/lang-markdown': [
    'markdown', 'markdownLanguage', 'insertNewlineContinueMarkup', 'deleteMarkupBackward',
  ],
};

/**
 * **B · 呈现与输入面**：键位表族、视图容器、行号、绘制/主题类、panel/tooltip。
 * ⛔ **仍然封闭**：加一项必须**同时**改 `design/0052` §2.1 的 B 栏格（下面 ④ 逐字核）。
 */
const B栏 = {
  '@codemirror/state': ['Prec'],
  '@codemirror/view': ['EditorView', 'keymap', 'lineNumbers'],
  '@codemirror/commands': ['historyKeymap'],
  '@replit/codemirror-vim': ['vim', 'Vim'],
};

function 读入口源码() {
  // ⚠️ 注释要挖成空格（保留行号语义，便于将来报 `文件:行`）：入口里到处在**解释**
  //    这些名字（"⛔ 这里没有 defaultKeymap"），注释不该被当成导出。
  return stripComments(fs.readFileSync(ENTRY_MJS, 'utf8'), false);
}

/**
 * 把入口源码里的 `export { … } from "…"`（**含多行写法**）解析成 `[{mod, names}]`。
 * ⚠️ 纯函数，闸门里拿假源码问它（⛔ 只断言"现在解析到几个"挡不住解析器被改窄）。
 */
function 解析入口导出(text) {
  const out = [];
  const re = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) {
    const names = m[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    out.push({ mod: m[2], names: names });
  }
  return out;
}

/** `design/0052` §2.1 的 B 栏那一行（⛔ 不做全文搜索：在别处提一句名字不算"进了表"）。 */
function 读设计B栏() {
  const 行 = fs.readFileSync(DESIGN_0052, 'utf8')
    .split('\n')
    .filter(function (l) { return l.indexOf('**B · 呈现与输入面**') >= 0; });
  return 行.join('\n');
}

test('⭐ 闸门 ③：`tools/cm6/entry.mjs` 的**每一行 export 必须落在两栏之一**（`design/0052` / `adr/0013`）', function () {
  // ⚠️ 这条闸门要挡的是**方向反转**，不是"多导出了一个函数"：
  //    旧口径「加一项 = 改设计」把 CM6 的**文档语义能力**（历史 / 语法树 / 选区 / 命令）
  //    一起关在门外，代价是本仓重写了删除（`bugs/0014`）、撤销（`bugs/0020`）、
  //    ATX 识别（`bugs/0015`/`0016`）。⇒ 2026-10-27 起按 `design/0052` §2.1 劈成两栏：
  //    A 栏（文档语义）加一项只改入口注释；A 栏里**不许**混进键位表与样式；
  //    B 栏（呈现与输入）**仍然封闭** —— 每一项都必须在设计 §2.1 的 B 栏格里点名。
  //
  // ⚠️ `cm6-bundle.test.js` 的「恰好相等」判据**一个字没松**：那边管"产物里到底有什么"，
  //    这里管"入口那一行的来历"。两份都红才说明有人绕过设计改了导出面。
  const entry = 读入口源码();
  const 导出 = 解析入口导出(entry);
  const 实际 = new Map(); // 符号 → 所在模块
  导出.forEach(function (g) {
    g.names.forEach(function (n) { 实际.set(n, g.mod); });
  });

  const 表 = [
    { 栏: 'A · 文档语义面', 符号: A栏 },
    { 栏: 'B · 呈现与输入面', 符号: B栏 },
  ];
  const 两栏 = new Map();
  表.forEach(function (t) {
    Object.keys(t.符号).forEach(function (mod) {
      t.符号[mod].forEach(function (n) { 两栏.set(n, { 栏: t.栏, 模块: mod }); });
    });
  });

  // ① 没有来历不明的：入口导出的每一个符号都必须在两栏之一，且**模块也对得上**。
  const 来历不明 = [];
  const 模块不符 = [];
  实际.forEach(function (mod, n) {
    const 归属 = 两栏.get(n);
    if (!归属) { 来历不明.push(n + ' ← ' + mod); return; }
    if (归属.模块 !== mod) { 模块不符.push(n + '：入口从 ' + mod + ' 取，两栏表写的是 ' + 归属.模块); }
  });
  assert.deepStrictEqual(
    来历不明, [],
    '⛔ 这些导出没有归到任何一栏 —— 先决定它是"文档状态"还是"呈现与输入"，' +
    '再改 `tools/cm6/entry.mjs` 的注释与 `design/0052` §2.1 的表：\n' + 来历不明.join('\n')
  );
  assert.deepStrictEqual(模块不符, [], '⛔ 两栏表与入口的模块对不上：\n' + 模块不符.join('\n'));

  // ② 两栏表里**列了但没导出**的 —— 反向：否则表会慢慢变成一份没人核对的愿望清单。
  const 只写在表里 = [];
  两栏.forEach(function (v, n) { if (!实际.has(n)) 只写在表里.push(n + '（' + v.栏 + '）'); });
  assert.deepStrictEqual(只写在表里, [], '⛔ 两栏表里有、入口里没有：\n' + 只写在表里.join('\n'));

  // ③ A 栏的两条禁止：⛔ 不许混进键位表族（那是 B 栏），⛔ 也不许混进样式/输入类扩展。
  const 键位表族 = ['keymap', 'historyKeymap', 'markdownKeymap', 'defaultKeymap',
    'standardKeymap', 'emacsStyleKeymap', 'basicSetup', 'drawSelection'];
  const 混进A = [];
  Object.keys(A栏).forEach(function (mod) {
    A栏[mod].forEach(function (n) { if (键位表族.indexOf(n) >= 0) 混进A.push(n); });
  });
  assert.deepStrictEqual(混进A, [], '⛔ A 栏（文档语义面）里混进了键位表/绘制类：' + 混进A.join(' / '));

  // ④ ⭐ B 栏**仍然封闭**：每一项都必须能在 `design/0052` §2.1 的 B 栏格里**逐字**找到。
  //    ⚠️ 这一格**读的是文档**，而 `docs/` 是**公开树里唯一被整棵排除的目录**
  //    （`design/0024` §2.1）。⇒ 拆成独立用例（见下一条），在导出树里如实 `skip`，
  //    ⛔ 不让它把「读不到设计」伪装成「设计核对通过」。

  // ⑤ 闸门本身是活的：拿**假源码**问解析器（⛔ 不是问"集合里有几项"）。
  assert.deepStrictEqual(
    解析入口导出('export { a, b } from "x";'),
    [{ mod: 'x', names: ['a', 'b'] }],
    '⛔ 解析器认不出 export 语句'
  );
  assert.deepStrictEqual(
    解析入口导出(stripComments('// export { z } from "y"', false)), [],
    '⚠️ 注释里的 export 被当成了真导出 —— 这正是"注解与实现分不开"的老坑'
  );
  assert.deepStrictEqual(
    解析入口导出('export { a } from "x";\nexport {\n  b,\n  c,\n} from "y";'),
    [{ mod: 'x', names: ['a'] }, { mod: 'y', names: ['b', 'c'] }],
    '⛔ 解析器认不出**多行** export 块（入口里就是这么写的）'
  );
  // 正面：真文件真的被解析到了（否则上面几条全绿也只是"什么都没读到"）。
  assert.ok(实际.size >= 25, '⛔ 只解析到 ' + 实际.size + ' 个导出 —— 入口路径或写法变了');
});

test('⭐ 闸门 ③-④：B 栏的每一项必须在 `design/0052` §2.1 的 B 栏格里**逐字**点名', function (t) {
  // ⚠️ 为什么单独一条：**读文档**的判据在**公开导出树里判不了** ——
  //    `docs/` 是唯一整棵不导出的目录（`design/0024` §2.1），而 CI 跑的正是导出树。
  //    混在上面那条里的话，缺口只有一个表现：`ENOENT` 被当成"测试坏了"，
  //    而修法若写成"读不到就返回"，就成了**跳过记绿**。⇒ 两种"读不到"必须分开：
  //    · `docs/` 整棵不在（公开树）⇒ 这条判据**不适用**，如实 `skip`；
  //    · `docs/` 在、`design/0052` 不在 ⇒ **路径漂了**，照样报红。
  if (!fs.existsSync(DOCS_DIR)) {
    t.skip('本树没有 `docs/`（公开导出树，`design/0024` §2.1）；回源仓库跑 `make test-js` 才判这一格');
    return;
  }
  assert.ok(
    fs.existsSync(DESIGN_0052),
    '⛔ `docs/` 在，但 `design/0052` 找不到 —— 改名或搬走了？判据的出处不能悄悄消失'
  );
  const 设计B栏 = 读设计B栏();
  assert.ok(设计B栏.length > 20, '⛔ 没读到 `design/0052` §2.1 的 B 栏那一行（路径或措辞变了？）');
  const 没写进设计 = [];
  Object.keys(B栏).forEach(function (mod) {
    B栏[mod].forEach(function (n) {
      if (设计B栏.indexOf('`' + n + '`') < 0) 没写进设计.push(n);
    });
  });
  assert.deepStrictEqual(
    没写进设计, [],
    '⛔ B 栏加一项必须改设计（`design/0052` §2.1 的 B 栏格里点名）：' + 没写进设计.join(' / ')
  );
});

test('⭐ `index.html`：`vendor/cm6.bundle.js` 必须**最先**（⛔ 顺序错的表现与"忘了 make cm6"一模一样）', function () {
  // ⚠️⚠️ 这条是本设计里**最难查**的一个错法：`editor/main.js` 在**运行时**读
  //    `window.rmdCM6`，而经典 `<script>` 是**按顺序执行**的——bundle 排到后面时
  //    那个全局还不存在，于是自证会报「bundle 没加载（跑 make cm6）」。
  //    ⛔ **而真正的原因是顺序**：两条路的表现**逐字相同**，只有把 bundle 挪到最前
  //    才能分辨。⇒ 必须有机器判据，⛔ 不能靠"下次记得"。
  const html = (FILES.find(function (f) { return f.rel === 'index.html'; }) || {}).text || '';
  const order = [];
  const tagRe = /<script\s+src="([^"]+)"/g;
  let m;
  while ((m = tagRe.exec(html))) order.push(m[1]);
  assert.ok(order.length >= 15, 'index.html 里没扫到 script 标签，正则写错了？');

  const 束 = order.indexOf('vendor/cm6.bundle.js');
  assert.ok(束 >= 0, '⛔ `index.html` 里没有 `vendor/cm6.bundle.js` 这一项 —— 编辑面整个不存在');
  assert.strictEqual(束, 0, '⛔ 它必须是**第一个** `<script>`（排第 ' + (束 + 1) + ' 位）');

  // ⭐ `editor/*.js` 必须排在 `services/*` **之后**、根 `main.js` **之前**：
  //    前者是因为 `editor/keys.js` 在**加载期**就取 `window.rmd.keymap`（`0009` 那个坑的同族）；
  //    后者是因为根 `main.js` 在加载期取 `window.rmd.editor*` 这一族。
  const 编 = order.filter(function (p) { return p.indexOf('editor/') === 0; });
  assert.ok(编.length >= 4, '⛔ `editor/*.js` 的脚本没扫全（现在是 ' + 编.length + ' 个）');
  const 服务 = order.filter(function (p) { return p.indexOf('services/') === 0; });
  const 键 = order.indexOf('services/keymap.js');
  const 根 = order.indexOf('main.js');
  assert.ok(键 >= 0 && 根 >= 0, '⛔ 找不到 `services/keymap.js` 或根 `main.js`');
  编.forEach(function (p) {
    const i = order.indexOf(p);
    assert.ok(i > 键, '⛔ ' + p + ' 排在 `services/keymap.js` **之前** —— 它在加载期取 `window.rmd.keymap`，会拿到 undefined');
    assert.ok(i < 根, '⛔ ' + p + ' 排在根 `main.js` **之后** —— 它在加载期取 `window.rmd.editor*`，会拿到 undefined');
  });
  // ⚠️ 反过来：`services/*` 那一片必须整体在根 `main.js` 之前（既有约定，上面那条只查了 editor）。
  assert.ok(服务.length >= 8, '⛔ `services/*.js` 没扫全');
});

test('动作_id_不在前端源码里被写死', function () {
  // ⚠️ 动作 id **是**前端要用的（`main.js` 的 `register`）——那是 §2.1 ② 说的
  //    "实现层"，它**必须**写出来。这里守的是**另一个**东西：
  //    ⛔ 源码里不许出现 `accel` 那种"键位数据"（`'Cmd+O'` 这种串）——
  //    它一旦出现在前端，就说明又有人自己抄了一份表。
  //
  // ⭐ 它真抓到过一次（2026-10-14 写这条测试时）：空文档页那句
  //    `showDocEmpty('用 Cmd+O 打开一个目录，或 Cmd+Shift+O 打开一份文档')`
  //    与侧边栏的 `'也可以按 Cmd+Shift+O 直接打开一份文档。'` 都是**手写的键位**。
  //    那两处已改为从后端表现算（`main.js` 的 `accelText` / `Sidebar` 的 `opts.keyText`）。
  //    ⚠️ 这才是这条测试的价值：它管的不是"有没有人偷懒"，是**用户看到 `⌘O`
  //    而按下去没反应**——一个只在键位改动之后才发作、且没有任何报错的缺陷。
  const hits = [];
  FILES.forEach(function (f) {
    if (f.rel === 'services/keymap.js') return;
    f.text.split('\n').forEach(function (line, i) {
      if (/\b(Cmd|Ctrl|Shift|Alt|Command)\s*\+/.test(line)) hits.push(f.rel + ':' + (i + 1) + '  ' + line.trim());
    });
  });
  assert.deepStrictEqual(hits, [], '前端源码里出现了键位数据（`owner` 表在后端）：\n' + hits.join('\n'));
});

// ────────────────────────────────────────────────────────────────
// ⑥ 显示串：前端**只当字符串用**，⛔ 不自己拼第二份
// ────────────────────────────────────────────────────────────────

test('显示串由_accel_派生_形状与_Rust_侧一致', function () {
  // ⭐ 这一条**不是**在 JS 里重写一遍 `display()`（那就成了第二份实现）：
  //    它拿**前端自己的** `splitAccel`（必须与 muda 的 `split_key_and_modifiers` 同规则）去切 `accel`，
  //    再按 Apple 的 `⌃⌥⇧⌘` 排一遍，看能不能复现后端给的那串。
  //    ⇒ 一旦前端的切分规则与后端分叉（`rfind('+')` 那一条），这里立刻红。
  //    ⚠️ 切的**只有规范 `accel`**（`Cmd+=` / `Cmd+-`…），⛔ 不切别名——
  //    别名里的 `Cmd++` / `Cmd+_` 本来就过不了 muda 的菜单解析（`kb/0016` §3），不进这条。
  const ORDER = [['ctrl', '⌃'], ['alt', '⌥'], ['shift', '⇧'], ['cmd', '⌘']];
  const ACCEL = {
    'settings.open': 'Cmd+,',
    'view.toggle-sidebar': 'Cmd+B',
    'file.open-directory': 'Cmd+O',
    'file.open-file': 'Shift+Cmd+O',
    'reader.font-inc': 'Cmd+=',
    'reader.font-dec': 'Cmd+-',
    'reader.font-reset': 'Cmd+0',
    // `design/0006` ＋ `0012`（⚠️ 这两条的键 2026-10-16 **换过**：`⌘E` 现归 `edit.toggle`）
    'file.save': 'Cmd+S',
    'edit.toggle': 'Cmd+E',
    'file.open-external-editor': 'Shift+Cmd+E',
    // `design/0009`
    'file.quick-open': 'Cmd+P',
    'file.refresh-index': 'Cmd+R',
    // `design/0011`
    'edit.find': 'Cmd+F',
    'edit.find-next': 'Cmd+G',
    'edit.find-prev': 'Shift+Cmd+G',
    // `design/0037`（顶栏折叠，⛔ 不进菜单）
    'view.toggle-chrome': 'Shift+Cmd+B',
  };

  // ⭐ 夹具**必须与真表同号同量**：少一条就是"整表断言在少测一条，而且全绿"。
  assert.deepStrictEqual(
    TABLE.map(function (r) { return r.id; }).slice().sort(),
    Object.keys(ACCEL).slice().sort(),
    '⛔ 夹具 TABLE 与这份 `ACCEL` 不一致（`accel` 是规范形式，只有一处）'
  );

  TABLE.forEach(function (row) {
    // ⚠️ 夹具里 `accel` 与这份表**必须一致**——`accel` 是"规范形式"，只有一处。
    assert.strictEqual(row.accel, ACCEL[row.id], row.id + ' 的 accel 与规范形式不一致');
    const p = K.splitAccel(row.accel);
    let s = '';
    ORDER.forEach(function (m) { if (p.mods.indexOf(m[0]) >= 0) s += m[1]; });
    s += p.key.toUpperCase();
    assert.strictEqual(row.display, s, row.id + ' 的显示串与 accel 派生不一致');
  });
});

test('显示串是_UTF16_可比的原样字符串', function () {
  // ⚠️ `⌘` / `⇧` 这些字符在 UTF-8 下是 3 字节、UTF-16 下是 1 个码元——
  //    而 `Rust` 侧的 `String` 与 JS 的 `String` 都是"码元序列"，
  //    只要**中间没人去切它**，两边看到的就是同一串。
  //    ⛔ 所以设置界面用 `textContent` 整串写进去（`Settings.js`），**不拆分**。
  TABLE.forEach(function (row) {
    assert.strictEqual(typeof row.display, 'string');
    assert.ok(row.display.length > 0);
    // 修饰键符号一律是**单个** BMP 码元（⛔ 不是 emoji 那种代理对）。
    assert.ok(row.display.length === Array.from(row.display).length,
      row.id + ' 的显示串里出现了代理对（会被切坏）');
  });
  assert.strictEqual(TABLE.find(function (r) { return r.id === 'file.open-file'; }).display, '⇧⌘O');
  assert.strictEqual(TABLE.find(function (r) { return r.id === 'reader.font-dec'; }).display, '⌘-');
});
