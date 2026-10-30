// `design/0014` §2 / §10 的单测：**Vim 装配层**（`src/editor/vim.js`）。
//
// ⭐ 为什么这些必须测：这个文件里三件事的错法**一个都不会报错**——
//
//   ① `build` 把上游那 4 项**包装**了一层 ⇒ 页面上看不出来，只有"Vim 装不上/装重了"
//      这种结果，而那时已经没有线索指回这里；
//   ② `:w` 没有**真的覆盖掉**上游那一份 ⇒ 上游的默认实现是
//      `if (命令表.save) … else if (cm.save) …`，而我们这个 bundle 里两条路都**不存在**
//      ⇒ `:w` 变成一个**彻底静默的 no-op**：不报错、不写盘、面板一个字不说。
//      ⭐ **用户会以为存了**；
//   ③ `hostKeys` 重复登记 ⇒ 上游的 `mapCommand` 内部是 `unshift`（**叠加**），
//      而症状要到"按一下 `⌃H` 走两格"时才看得见。
//
// ⚠️ 这里的 `Vim` 是一份**假的**：本文件验的是**我们那次调用长什么样**，
//    ⛔ 不是上游的行为——上游那份由 `make probe-vim-keys` 在真 bundle 上量
//    （0b 扩展形状 / 0c 谁处理哪个键 / 0e 块光标）。
// ⚠️ 纯逻辑、无 DOM、无计时器 ⇒ 可 `node --test`。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EdVim = require('../../src/editor/vim.js');

/**
 * ⚠️ 一份**最小的** `Vim` 替身：只实现我们真的调到的两个成员。
 * ⛔ 别实现"键位表怎么匹配"——那是上游的事（`make probe-vim-keys` 那半）。
 */
function 假Vim() {
  const 注册 = [];
  const 表 = [];
  return {
    defineEx: function (name, short, fn) {
      注册.push({ name: name, short: short, fn: fn });
      this.exCommands = this.exCommands || {};
      this.exCommands[name] = fn;      // ⚠️ 真上游也是**赋值** ⇒ 重复调不堆叠
    },
    mapCommand: function (keys, type, name, args, extra) {
      表.push({ keys: keys, type: type, name: name, args: args, extra: extra });
    },
    _注册: 注册,
    _表: 表,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ① `build` —— `INV-VIM-01`：上游返回的那几项**原样**交出去
// ─────────────────────────────────────────────────────────────────────────

test('build：返回的是上游那个数组**本身**（⛔ 一个包装都不加）', () => {
  // ⚠️ 判据是**引用相等**（`strictEqual`），⛔ 不是 `deepStrictEqual`：
  //    包一层（哪怕是 `[].concat(...)`）之后，"里面那 4 项原样"就**不可断言**了，
  //    而页面上完全看不出来——`design/0014` §1.1 的更正块正是在说这类事。
  const 四件 = [{ __e: 1 }, { __e: 2 }, { __e: 3 }, { __e: 4 }];
  const 收到 = [];
  const CM6 = { vim: function (o) { 收到.push(o); return 四件; } };
  const r = EdVim.build(CM6, { status: true });
  assert.strictEqual(r, 四件, '⛔ 必须是**同一个数组**（复制/包装都会让这一条失去意义）');
  assert.strictEqual(r.length, 4);
});

test('build：`status` 默认 `true`（裁定 (c)：**用上游那个模式面板**）', () => {
  // ⭐ 裁定 (c) 的原话是「不自研另一套指示器」⇒ 这一项**必须**是上游自带的那个面板。
  //    ⚠️ `status: false` 时上游返回的第 4 项是个 StateField（**没有可见面板**），
  //    效果是"Vim 开着但用户看不出现在是什么模式"——所以默认值是有内容的。
  const 收到 = [];
  const CM6 = { vim: function (o) { 收到.push(o); return []; } };
  EdVim.build(CM6);                          // ⛔ 不传 opts
  EdVim.build(CM6, {});                      // ⛔ 传了空 opts
  EdVim.build(CM6, { status: false });       // 显式关（只留排障用）
  assert.deepStrictEqual(收到, [{ status: true }, { status: true }, { status: false }],
    '⛔ 默认不是 true ⇒ 模式面板不会出现');
});

test('build：**不缓存**（记忆化是调用方的事，⛔ 别在这里再记一份）', () => {
  // ⚠️ `editor/main.js::取VimExt` 已经负责"只 build 一次"（`INV-VIM-07`：
  //    反复重建会换掉寄存器/宏/上次的模式）。这里再缓存一份就是**第二个真值**，
  //    而两份缓存的失效时机不同 ⇒ 表现是"进过两次编辑态之后，Vim 的状态时有时无"。
  let 次 = 0;
  const CM6 = { vim: function () { 次 += 1; return []; } };
  EdVim.build(CM6);
  EdVim.build(CM6);
  assert.strictEqual(次, 2, '⚠️ 每次调 `build` 都该真的问上游一次');
});

// ─────────────────────────────────────────────────────────────────────────
// ② `installEx` —— `INV-VIM-03`：`:w` **只调既有保存入口**
// ─────────────────────────────────────────────────────────────────────────

test('installEx：覆盖掉上游那份 `write`，且**只**调保存器（一次）', () => {
  const V = 假Vim();
  let 存了几次 = 0;
  const 写 = EdVim.installEx(V, function () { 存了几次 += 1; });

  assert.deepStrictEqual(V._注册.map(function (r) { return [r.name, r.short]; }),
    [['write', 'w']], '⛔ 名字/前缀写错 = `:w` 落到上游那份静默 no-op 上');
  assert.strictEqual(V.exCommands.write, 写,
    '⭐⭐ 表里那一条必须是**我们返回的那个函数** —— 这就是"真的覆盖了"的判据');

  // ⚠️ 上游调我们时递的是 `(cm, params)`，而且**紧接着**就会调 `params.callback()`
  //    （`core/vim.js`：我们这一条没有 `possiblyAsync` ⇒ 它在我们的 promise 落定**之前**就响了）。
  //    ⇒ 这里递一个**会炸的** `callback`：它被调到就说明我们又自己报了"成功"。
  const params = { callback: function () { throw new Error('⛔ 这里不许自己报成功（见 vim.js 的注释）'); } };
  写({ __cm: true }, params);
  assert.strictEqual(存了几次, 1, '⭐ 一次 `:w` 恰好一次保存');
});

test('installEx：保存器是**取值函数**，⛔ 不是一份快照', () => {
  // ⚠️ 保存器**每次进编辑态重建**（`exitEdit` 还会把它置回 `null`）⇒ 递一份快照的话，
  //    第二次编辑态里 `:w` 写的是**上一个会话**的保存器，而它闭包里的 `onClean` / `rev` 都是旧的
  //    —— 表现是"改完按 `:w`，提示说已保存，但脏标记不消（或者更坏：消了）"。
  //    ⭐ `src/main.js` 递的正是 `function () { …editorSave.save(); }`（那个变量每次重指）。
  const V = 假Vim();
  let 当前 = 'A';
  const 记 = [];
  const 写 = EdVim.installEx(V, function () { 记.push(当前); });
  写();
  当前 = 'B';   // ＝ 退出又进了编辑态，模块变量重指到新的保存器
  写();
  assert.deepStrictEqual(记, ['A', 'B'], '⛔ 第二次还写 A ⇒ 递的不是取值函数');
});

test('installEx：重复调只是把同一个位置再赋一次（⛔ 表里不堆叠）', () => {
  const V = 假Vim();
  EdVim.installEx(V, function () {});
  const 第二个 = EdVim.installEx(V, function () {});
  assert.strictEqual(V._注册.length, 2, '⚠️ 两次都真的调了 `defineEx`（幂等靠的是赋值，不是提前 return）');
  assert.strictEqual(V.exCommands.write, 第二个, '后一次赢');
  assert.deepStrictEqual(Object.keys(V.exCommands), ['write'],
    '⭐⭐ 表里仍然**只有一条** —— 堆起来的话 `:w` 会执行 N 遍（保存 N 次盘）');
});

// ─────────────────────────────────────────────────────────────────────────
// ③ `hostKeys` —— 裁定 (e)：`⌃K` / `⌃H` 的宿主键位适配
// ─────────────────────────────────────────────────────────────────────────

test('hostKeys：三条登记各是什么（⭐ `context` 只有 insert 那一条写）', () => {
  const V = 假Vim();
  assert.strictEqual(EdVim.hostKeys(V), true, '第一次返回 true = 真的登记了');
  assert.deepStrictEqual(V._表.map(function (x) {
    return { keys: x.keys, type: x.type, args: x.args, extra: x.extra };
  }), [
    // `⌃H`：借上游**既有**的退格分支 ⇒ normal/visual 下左移一格。
    // ⚠️ **不写 `context`**：insert 语境会跳过它 ⇒ 那里保留 WebKit 的退格
    //    （＝ Vim 在 insert 下 `⌃H` 的语义，⭐ 这一条是"没写"换来的，⛔ 别去补一个 context）。
    { keys: '<C-h>', type: 'keyToKey', args: undefined, extra: { toKeys: '<BS>' } },
    // `⌃K`：`idle` 是**上游已有**的类型（`core/vim.js` 的 `<C-w>` 就用它）
    // ⇒ 落到命令分派的 `default:` 分支：**什么都不做，但 handler 返回真 ⇒ `preventDefault` 生效**。
    { keys: '<C-k>', type: 'idle', args: undefined, extra: {} },
    // ⭐ 必须**单独**再来一条：上面那条（不写 context）在 insert 语境下会被短路跳过。
    { keys: '<C-k>', type: 'idle', args: undefined, extra: { context: 'insert' } },
  ], '⛔ 三条的形态变了 —— normal/visual 与 insert 的分野全在 `context` 上');
});

test('hostKeys：幂等 —— 第二次什么都不做（`mapCommand` 内部是 `unshift`，会叠加）', () => {
  // ⚠️ 上游那个 `unshift` 是**往模块级那张表里加**，重复调就堆同一条
  //    ⇒ 症状是"按一下 `⌃H` 走两格 / `⌃K` 的判定做两遍"。
  // ⭐ 标记挂在 `Vim` 上是对的：它是模块单例（⛔ 别挂在这个文件的作用域上——
  //    那样"换一份 `Vim`"会被误判成"已装配"）。
  const V = 假Vim();
  EdVim.hostKeys(V);
  const 一次 = V._表.length;
  assert.strictEqual(一次, 3);
  assert.strictEqual(EdVim.hostKeys(V), false, '第二次必须返回 false');
  assert.strictEqual(V._表.length, 一次, '⛔ 重复调不许再往表里塞一遍');
  // ⚠️ 反向：**另一个** `Vim` 实例上必须照常登记（标记认的是"那个对象"，⛔ 不是全局布尔）。
  const W = 假Vim();
  assert.strictEqual(EdVim.hostKeys(W), true);
  assert.strictEqual(W._表.length, 3);
});

// ─────────────────────────────────────────────────────────────────────────
// ④ 接线（源码级）：`src/main.js` 到底有没有接上
//
// ⭐⭐ 这一节守的是本仓库**反复出现的那一族接缝**——两侧各自都有测试，
//    断的是**中间那一跳**。同族前四例：`bugs/0003` 的字段类型、`bugs/0004` 的
//    `markEdited`、§11 的 `createDriver`、`bugs/0006` 的三条接线闸门。
//
// ⚠️ 为什么这里非写源码级不可：`src/main.js` 是**根脚本**（不进 `require`），
//    而上面 ①②③ 那三节验的全是 `vim.js` **自己**的行为——`hostKeys` 再对，
//    `src/main.js` 不调它也等于没有（⛔ 症状是 `⌃K`/`⌃H` **静默**回到 WebKit 默认行为，
//    而那正是裁定 (e) 要修的东西）。
// ─────────────────────────────────────────────────────────────────────────

const SRC_MAIN = path.join(__dirname, '..', '..', 'src', 'main.js');

/**
 * ⭐ **裸判据**：给一段 `src/main.js` 的源码，判它**有没有把 Vim 装到编辑面上**。
 *
 * ⚠️ 之所以要抽成函数（而不是就地写一串正则）：让下面那条测试能**拿坏源码问它**。
 *    否则哪天有人把范围改窄（比如只扫 `editor/`），闸门会**照样全绿**——
 *    `tests/js/editor.test.js` 与 `vim-save.test.js` 里都内嵌了同一形态的裸判据。
 *
 * ⚠️ 它**自己剥注释**：所以"注释里提一句 `hostKeys` 就过"这件
 *    在真闸门与裸判据上是**同一条规矩**（不像 `keymap.test.js` 那条裸判据
 *    故意保留"会命中注释"的差别——那一条的用途不同）。
 */
function 判Vim接线(code) {
  const 剥 = function (s) {
    return s
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  };
  const c = 剥(code);
  // ⚠️ 计数：`setupEditorVim()` 的出现次数 **减去**它的定义次数。
  //    ⛔ 不写成"文件里有这个词"——那样**只留定义、删掉调用**也会绿，
  //    而"定义在、没人调"正是这一节最想拦的形态。
  const 总 = (c.match(/(^|[^a-zA-Z])setupEditorVim\s*\(\s*\)/g) || []).length;
  const 定义 = (c.match(/function\s+setupEditorVim/g) || []).length;
  return {
    // ① 装配函数**真的被调**（⛔ 不是"定义在那儿"）
    被调用: 总 - 定义 >= 1,
    // ② 裁定 (e)：宿主键位真的登记了（⛔ 症状静默：`⌃K`/`⌃H` 回到 WebKit 默认）
    装了宿主键位: /EdVim\s*\.\s*hostKeys\s*\(\s*CM6\s*\.\s*Vim\s*\)/.test(c),
    // ③ 裁定 (a)：编辑面**订阅**了开关（⛔ 症状静默：开着设置改不动已经在编辑的那一栏）
    订阅了开关: /editor\s*\.\s*setVim\s*\(\s*theme\s*\.\s*applied\s*\.\s*vimMode\s*\)/.test(c),
    // ④ 冷启动那一路：挂载时带**当刻的**开关值，
    //    ⛔ 写死 `true`/`false` 的话，"设置里开着、进编辑态却是普通编辑"（或反过来）。
    挂载带开关: /vimOn\s*:\s*[^,}\n]*theme\s*\.\s*applied\s*\.\s*vimMode/.test(c),
  };
}

test('⭐⭐ 接线（源码级）：`src/main.js` 真的把 Vim 装到了编辑面上', () => {
  const r = 判Vim接线(fs.readFileSync(SRC_MAIN, 'utf8'));
  assert.ok(r.被调用, '⛔ `setupEditorVim()` 定义了却没人调 —— 下面三条全都成了死代码');
  assert.ok(r.装了宿主键位, '⛔ 没有 `EdVim.hostKeys(CM6.Vim)` —— 裁定 (e) 的落法丢了，'
    + '`⌃K`/`⌃H` 会**静默**回到 WebKit 的默认行为（那正是要被修掉的那件事）');
  assert.ok(r.订阅了开关, '⛔ 没有 `editor.setVim(theme.applied.vimMode)` —— '
    + '开着编辑态去改设置，那一栏不会有任何反应（而设置里那个复选框照常打勾）');
  assert.ok(r.挂载带开关, '⛔ `mount(…, { vimOn: … })` 没接上 `theme.applied.vimMode` —— '
    + '冷启动那一路会漏（"设置里明明开着，进编辑态却是普通编辑"，且**没有任何提示**）');
});

test('⭐ 判据自检：拿坏源码问它，四项必须各自变假（⛔ 不许有一项恒真）', () => {
  // ⭐ 这就是裸判据的用处：⛔ 没有它，"接线还在不在"可能只是一句**空话**。
  const 好 = 'function setupEditorVim() { EdVim.hostKeys(CM6.Vim); '
    + 'theme.subscribe(function () { if (!editor) return; editor.setVim(theme.applied.vimMode); }); }\n'
    + 'function setupEdit() { setupEditorVim(); }\n'
    + 'editor.mount(t, f, { vimOn: !!(theme && theme.applied.vimMode) });';
  assert.deepStrictEqual(判Vim接线(好),
    { 被调用: true, 装了宿主键位: true, 订阅了开关: true, 挂载带开关: true },
    '基线（好源码）必须先全真 —— ⚠️ 基线不成立的判据是个**恒假**的判据');

  // ① 只留定义、删掉调用 —— ⭐ 这正是"定义在、没人调"，也是最容易漏的一种。
  assert.strictEqual(判Vim接线('function setupEditorVim() { EdVim.hostKeys(CM6.Vim); }').被调用, false,
    '⛔ 没了调用点，`被调用` 必须变假（否则这一项是恒真的）');
  // ② 把 `hostKeys` 注释掉 —— 剥注释之后必须等于没写。
  assert.strictEqual(判Vim接线(好.replace('EdVim.hostKeys', '// EdVim.hostKeys')).装了宿主键位, false,
    '⛔ 注释里提一句不算装 —— 真闸门扫的是**剥完注释**的源码');
  // ③ 把 setVim 改成别的动作（看起来也在"响应设置"）。
  assert.strictEqual(判Vim接线(好.replace('editor.setVim', 'editor.markClean')).订阅了开关, false,
    '⛔ 不是 `setVim` 就不算 —— 别的 setter 也会在切主题时被调到，但它不改键位');
  // ④ 挂载时写死 false。
  assert.strictEqual(
    判Vim接线(好.replace('!!(theme && theme.applied.vimMode)', 'false')).挂载带开关, false,
    '⛔ 写死字面量 ⇒ 冷启动那一路断了（设置开着也进不去）');
});


// ─────────────────────────────────────────────────────────────────────────
// ⑤ 顶栏的**快速开关**（2026-10-20 用户点题：「Vim 模式要在一个显眼的地方，
//    选择打勾。快速开关。」）
//
//    ⚠️ 这一族最容易错成"**多出一个真源**"：顶栏自己攒一个 `vimOn`，
//       于是"设置里关掉、顶栏还勾着"（或反过来），而两处单独看都没毛病。
//       判据因此钉在**读哪、写哪**，⛔ 不是"有没有那个控件"。
// ─────────────────────────────────────────────────────────────────────────

const SRC_HTML = path.join(__dirname, '..', '..', 'src', 'index.html');

/** ⭐ **裸判据**：给 `main.js` 的一段源码，判顶栏开关**是不是那两张脸之一**。 */
function 判快速开关(code) {
  const c = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const 总 = (c.match(/(^|[^a-zA-Z])setupVimToggle\s*\(\s*\)/g) || []).length;
  const 定义 = (c.match(/function\s+setupVimToggle/g) || []).length;
  return {
    // ① 接线函数**真的被调**（⛔ "定义在、没人调"）
    被调用: 总 - 定义 >= 1,
    // ② 写：只走唯一写入口（⛔ `theme.applied.vimMode = true` 那种直接赋值是第二个真源）
    只走唯一写入口: /theme\s*\.\s*setVimMode\s*\(\s*box\s*\.\s*checked\s*\)/.test(c)
      && !/applied\s*\.\s*vimMode\s*=(?!=)/.test(c),
    // ③ 读：回填自 `theme.applied.vimMode`（⛔ 自己攒变量）
    回填自生效值: /box\s*\.\s*checked\s*=\s*theme\s*\.\s*applied\s*\.\s*vimMode\s*===?\s*true/.test(c),
    // ④ 订阅：别处改了（设置覆盖层）这里要跟着变
    订阅了生效值: /theme\s*\.\s*subscribe\s*\(\s*sync\s*\)/.test(c),
  };
}

test('⭐⭐ 接线（源码级）：顶栏那个「Vim」复选框是**同一个状态的一张脸**，⛔ 不是第二个真源', () => {
  const r = 判快速开关(fs.readFileSync(SRC_MAIN, 'utf8'));
  assert.ok(r.被调用, '⛔ `setupVimToggle()` 定义了却没人调 —— 顶栏那个框点了也不会有人接');
  assert.ok(r.只走唯一写入口, '⛔ 没走 `theme.setVimMode(box.checked)`（或绕开它直接赋值 —— '
    + '那会造出第二个真源："设置里关掉、顶栏还勾着"，两处单独看都没毛病）');
  assert.ok(r.回填自生效值, '⛔ 勾选态没从 `theme.applied.vimMode` 回填 —— '
    + '进编辑态前改过设置，顶栏会显示错的状态');
  assert.ok(r.订阅了生效值, '⛔ 没 `theme.subscribe(sync)` —— 设置覆盖层里改开关，顶栏不会跟着动');
});

test('⭐⭐ 结构（源码级）：`index.html` 的顶栏里**真的**有这个复选框', () => {
  const html = fs.readFileSync(SRC_HTML, 'utf8');
  // ⚠️ 只在 `#toolbar` 那一段里找：放在别处（比如正文容器里）就**不是**"显眼的地方"了，
  //    而且 `#doc` 里必须是**纯渲染结果**（`design/0006` 的纪律）。
  const 起 = html.indexOf('id="toolbar"');
  assert.ok(起 >= 0, '⛔ 找不到 `#toolbar` —— 判据的前提没了');
  const 尾 = html.indexOf('id="status"', 起);
  const 顶栏 = html.slice(起, 尾 > 起 ? 尾 : undefined);
  assert.ok(/<label[^>]*class="toolbar-toggle"/.test(顶栏), '⛔ 顶栏里没有 `.toolbar-toggle` 这个形态');
  assert.ok(/input[^>]*id="vim-toggle"/.test(顶栏), '⛔ 顶栏里没有 `#vim-toggle`');
  assert.ok(顶栏.indexOf('id="vim-toggle"') < 顶栏.indexOf('id="btn-edit"'),
    '⛔ 它跑到「编辑」右边去了 —— 与编辑态直接相关的键应当在**进/出编辑**那个按钮之前');
});

test('⭐ 判据自检：拿坏源码问它，四项必须各自变假（⛔ 不许有一项恒真）', () => {
  const 好 = 'function setupVimToggle() { const box = 0; '
    + 'function sync() { box.checked = theme.applied.vimMode === true; } '
    + 'box.addEventListener("change", function () { theme.setVimMode(box.checked); }); '
    + 'theme.subscribe(sync); }\nfunction setupEdit() { setupVimToggle(); }';
  assert.deepStrictEqual(判快速开关(好),
    { 被调用: true, 只走唯一写入口: true, 回填自生效值: true, 订阅了生效值: true },
    '基线（好源码）必须先全真');

  assert.strictEqual(判快速开关('function setupVimToggle() { theme.setVimMode(true); }').被调用, false,
    '⛔ 定义在、没人调 ⇒ `被调用` 必须变假');
  assert.strictEqual(
    判快速开关(好.replace('theme.setVimMode(box.checked)', 'theme.applied.vimMode = box.checked')).只走唯一写入口,
    false, '⛔ 绕开唯一写入口直接赋值 ⇒ 必须是第二个真源');
  assert.strictEqual(
    判快速开关(好.replace('box.checked = theme.applied.vimMode === true', 'box.checked = vimOn')).回填自生效值,
    false, '⛔ 回填自本地变量 ⇒ 两处状态会分叉');
  assert.strictEqual(判快速开关(好.replace('theme.subscribe(sync)', '')).订阅了生效值, false,
    '⛔ 不订阅 ⇒ 设置里改它，顶栏不跟');
});
