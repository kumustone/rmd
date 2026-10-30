// 编辑态的 Vim 键位（`design/0014`）——**装配层**：把上游那个 Vim 扩展接进编辑面。
//
// # ⛔ 本文件只做三件事，且**全是纯装配**
//
// | # | 函数 | 做什么 |
// |---|---|---|
// | 1 | `build(CM6, opts)` | 调上游 `vim(...)`，把它的返回**原样**交出去（`INV-VIM-01`） |
// | 2 | `installEx(Vim, save)` | `:w` —— ⭐ 只调**既有保存器**（`INV-VIM-03`） |
// | 3 | `hostKeys(Vim)` | 裁定 (e) 的**宿主键位适配**：`⌃K` / `⌃H` |
//
// ⛔ **无 DOM、⛔ 无 IPC、⛔ 不碰 `window.rmd.*` 的别的东西**（同 `save.js` / `sync.js` 那份纪律）。
// ⚠️ 因此 `hostKeys` / `installEx` 能直接被 `node --test` 用**假 Vim** 验，⛔ 不必起 WebKit。
//
// # ⚠️⚠️ 为什么这里**不**包 `Prec`（`design/0014` §1.1 的更正块）
//
// `design/0012` 的链图里写过「Vim 插槽 → `Prec.higher`」——⛔ **那句已作废，两重错**：
//   ① `Prec` 的成员只有 `highest / high / default / low / lowest`，**没有 `higher`**
//      ⇒ 写下去是 `TypeError`（步骤 0b 的探针第一版就是这么挂的）；
//   ② 就算有也**轮不到**：上游那个 Vim 插件挂的是 `EditorView` 的**原生 keydown handler**，
//      ⛔ **不在 `keymap` 那个 facet 里** ⇒ 包不包 `Prec` 对"谁先拿到键"**毫无影响**。
//
// ⭐ **真正决定次序的是扩展在 `editor/main.js::extensions()` 数组里的位置**：
//    Vim 排在转发层**之前** ⇒ 它 `preventDefault()` 掉的键根本到不了转发层。
//    ⚠️ 所以本函数的返回值**一个包装都不加**——多包一层只会让"里面那 4 项原样"变得难断言。
//
// # ⚠️ 关于本文件里的 `'<C-h>'` / `'<C-k>'` / `'<BS>'` 这类串
//
// ⛔ **这不是"在源码里写死键位"**（`INV-SET-01` 禁止的是那个）。
// 那条闸门（`tests/js/keymap.test.js`）认的记法是**应用自己的** `Cmd+S` 形态
// （正则 `\b(Cmd|Ctrl|Shift|Alt|Command)\s*\+`），而这里写的是**上游 `mapCommand` 的键名格式**
// （尖括号记法）——⭐ **两者形态不同、来源也不同**：后者本来就没有"后端那张表"可派生。
// ⚠️ **别因为看到"源码里有键位串"就去放宽那条闸门**——那是把守卫拆掉，不是修缺陷。
//
// ⚠️ 另一个同族的坑：`keymap.test.js` 有一条**源码级子串扫描**，禁的是四个别的库的导出名
// （`basicSetup` 那一族）。⇒ ⛔ **本文件的注释里也不许出现那四个词**（判的是文本、不是语义）。
//
// ⚠️ 与 `src/` 下每个文件一样包一层 IIFE（经典脚本的顶层 `const` 共享全局词法作用域，
//    撞名会让**整个文件不执行**且 stderr 全静默——2026-10-13 真踩过）。
(function () {
  'use strict';

  /**
   * ⭐ **装 Vim 扩展**（`INV-VIM-01`：返回的 4 项原样，⛔ 不增删 / 不重排 / 不替换）。
   *
   * @param {object} CM6 `window.rmdCM6`（`vim` 就在它上面）
   * @param {object} [opts]
   * @param {boolean} [opts.status=true] ⭐ 裁定 (c)：**用上游自带的模式面板**（⛔ 不自研指示器）。
   *   ⚠️ `false` 时上游返回的第 4 项是个 StateField（没有可见面板）——
   *   本设计**不用**那条路，参数留着只为便于排障。
   * @returns {Array} 上游 `vim()` 的返回数组（恰好 4 项，见 `design/0014` §1.3 ①）
   */
  function build(CM6, opts) {
    const o = opts || {};
    const 要面板 = o.status === undefined ? true : !!o.status;
    return CM6.vim({ status: 要面板 });
  }

  /**
   * ⭐⭐ **`:w`**（裁定 (b)）。全项目**只有这一条** ex 命令被我们注册。
   *
   * ## 为什么必须注册（⛔ 这不是"顺手加一个功能"）
   *
   * 上游**自带**一份 ex 写盘的默认实现（`core/vim.js:6398-6404`）：
   * `if (命令表.save) … else if (cm.save) …`。⚠️ **在我们这个 bundle 里两条路都不存在**
   * （两个成员都是 `undefined`）⇒ ⛔ **不注册的话 `:w` 是一个彻底静默的 no-op**：
   * 不报错、不写盘、面板一个字不说——⭐ **用户会以为存了**。
   * ⇒ `defineEx` 走的是 `exCommands[name] = func`（`:893`）**直接覆盖**那一份 ⇒ 装上就赢。
   * ⚠️ 而"真的赢了"这件事**必须有断言**（`INV-VIM-03` 的那半），⛔ 不能靠"我看了一眼注册成功"。
   *
   * ## ⚠️⚠️ 为什么不能顺手在这里显示"已保存"
   *
   * 上游执行 ex 命令是 **`exCommands[name](cm, params);`（同步调用、返回值直接丢弃、⛔ 不 await）**，
   * 紧接着 `if ((!command || !command.possiblyAsync) && params.callback) params.callback();`
   * —— 我们注册的条目**没有 `possiblyAsync`** ⇒ ⭐ **`params.callback()` 在我们那个 promise
   * 落定之前就被调了**。⇒ 想在这里报"成功"就必须**自己等**，
   * 而那正是 `save.js` 已经在做的事（`onStatus`）⇒ ⛔ **这里一个字都不许说**。
   *
   * ## 因此函数体只有一件事：调既有保存器
   *
   * 授权 / 冲突检查 / 组合态保护**全是那条路自带的**（`INV-EDIT-10`）。
   * ⛔ 不开第二条写路径，⛔ 不在这里 `catch` 之后改状态——失败时**不清脏标记**
   * 是 `save.js` 的既有语义（它只在成功路径上调 `onClean`）。
   *
   * ⚠️ **幂等**：`defineEx` 是赋值 ⇒ 重复调只是把同一个函数再放一次，⛔ 不会堆叠（与 `hostKeys` 不同）。
   *
   * @param {object} Vim `window.rmdCM6.Vim`
   * @param {Function} save `() => Promise` —— ⭐ **取"当前那个保存器"的函数**
   *   （保存器每次进编辑态重建 ⇒ 这里必须是取值函数，⛔ 不是一份快照）。
   *   ⚠️ 参数是**函数**而不是 `{save}` 对象，是为了让本文件对"保存器长什么样"零知识。
   * @returns {Function} 注册进去的那个函数（便于测试直接调它，⛔ 不必起编辑面）
   */
  function installEx(Vim, save) {
    function 写(cm, params) {
      // ⭐ 唯一的一跳。⚠️ 返回值/异常都在保存器内部处理完了（它自己 `onStatus` 报错、
      //    自己决定清不清脏）⇒ 这里**既不 await 也不 catch**，只是把调用发出去。
      //    ⚠️ 若保存器换成会抛的实现，这里必须重新审——`save.js` 的实现**不抛**。
      save();
    }
    Vim.defineEx('write', 'w', 写);
    return 写;
  }

  /** ⭐ 幂等标记（见 `hostKeys` 的说明）。⚠️ 挂在 `Vim` 上，因为它是**模块单例**。 */
  var 已装配 = '__rmdVimHostKeys';

  /**
   * ⭐⭐ **宿主键位适配**（裁定 (e)：选 B，一起修 `⌃K` / `⌃H`）。
   *
   * ## 为什么要有这一条
   *
   * `⌃K` / `⌃H` **不在上游任何一张键位表里** ⇒ 装上 Vim 之后它们**照旧落到 WebKit**
   * （`killLine` 删到行尾 / `deleteBackward` 删一个字符）。⚠️ 真按键实测（`design/0012` §2.3-4
   * ＋ `editor-key-2026-10-16`）：`⌃K` 把文本 71 → **51**、`⌃H` 71 → **70**。
   * ⭐ 裁定的口径是「**正常的删除不等于数据损坏**」——要禁的是**绕过模式约束**那一类：
   * `⌃K` 的 `killLine` 正是（在 `normal` 模式下删字），而 `⌃H` 的方向本来就是"退格/左移"。
   *
   * ## 落法：⛔ 不挂我们自己的 `keymap`，只用上游的公开 API
   *
   * `Vim.mapCommand(keys, type, name, args, extra)`（`core/vim.js:6747`）内部做的是
   * `unshift` 进上游那张键位表 ＋ 记账 ⇒ ⭐ **不需要我们的扩展、不需要新增任何 CM6 导出、
   * 也不碰 `vim()` 的数组**，而键**照样会被它的 handler 收掉并 `preventDefault`**
   * （能匹配上 ⇒ 不再走"没匹配"那条放行分支）。
   * ⭐ 这正是裁定要的「**放在既有键位策略中、使用上游命令**」。
   *
   * ## ⚠️ 三条从源码读出来的约束
   *
   * 1. ⛔ **必须幂等**：那个 `unshift` 会**叠加**（重复调 ⇒ 表里堆同一条）。本函数用
   *    `Vim` 上的一个标记守住——它是模块单例，标记跟着它走是对的作用域。
   * 2. ⚠️ 它改的是**模块级**的表 ⇒ 但**不构成"关掉开关还留着"**：那张表只在
   *    Vim 的 handler 存在时才被查，而 handler 由插件提供 ⇒ **随 `vimExt` 一起下去**。
   * 3. ⚠️⚠️ **`context` 的语义**（一手读 `core/vim.js:3625-3628` 的 `commandMatches`）：
   *    - 在 **insert** 语境下，**凡 `context` 不是 `'insert'` 的条目一律跳过**
   *      （短路条件 `context == 'insert' && command.context != 'insert'`）；
   *    - 在 **normal / visual** 语境下，`context` **不写**的条目**两种都匹配**
   *      （`visual` 只在**写了** `context: 'normal'` 时**不**匹配）。
   *
   *    ⇒ ⭐ **不写 `context` = 覆盖 normal ＋ visual（⛔ 不含 insert）**。
   *    ⚠️ 别按"不写就是三模式通吃"来用（`design/0014` §2.3-5 那张表原文如此，已就地更正）。
   *
   * ## 各模式的预期（裁定要求"先明确，再处理"）
   *
   * | 键 | normal / visual | insert |
   * |---|---|---|
   * | `⌃H` | **左移一格，⛔ 不改文本**（借上游既有的 `<BS>` 绑定，我们不定义"什么算左移"） | **退格**（＝正常编辑语义，⭐ 由"不写 `context` ⇒ insert 跳过"**自动**得出来，⛔ 不需要为它写一行代码） |
   * | `⌃K` | **什么都不做**（Vim 里它是双字符组合键的前缀，而上游没实现那一套） | 同上 |
   *
   * ⚠️ `⌃K` 为什么是 no-op 而**不是**"保留 `killLine`"：`killLine` 是 WebKit 的 Emacs 绑定，
   * 在 Vim 的 `normal` 模式下**绕过模式约束**改文档 —— 正是裁定点名要禁的那一类；
   * 而 Vim 自己的 `⌃K` **从不删东西** ⇒ **no-op 才**是"按 Vim 的语义"。
   * ⭐ 那个 `'idle'` 类型是**上游已有的**（`core/vim.js:200` 的 `<C-w>` 就用它）：
   * 它落到命令分派的 `default:` 分支 ⇒ **什么都不做，但 handler 返回真 ⇒ `preventDefault` 生效**。
   *
   * @param {object} Vim `window.rmdCM6.Vim`
   * @returns {boolean} 这次**真的登记了**吗（`false` = 之前已经登记过，本次什么都没做）
   */
  function hostKeys(Vim) {
    if (Vim[已装配]) return false;

    // `⌃H`（normal ＋ visual）：转成上游已有的退格分支 ⇒ 左移一格。
    // ⚠️ **不写 `context`** 是要的形态：insert 语境会跳过它 ⇒ 那里保留 WebKit 的退格
    //    （⭐ 也正是 Vim 在 insert 下 `⌃H` 的语义）。
    Vim.mapCommand('<C-h>', 'keyToKey', undefined, undefined, { toKeys: '<BS>' });

    // `⌃K`（normal ＋ visual）：no-op，只把它从 WebKit 手里拿回来。
    Vim.mapCommand('<C-k>', 'idle', undefined, undefined, {});
    // `⌃K`（insert）：同上。⚠️ 必须**单独**登记一条——不写 `context` 的那条到不了 insert。
    Vim.mapCommand('<C-k>', 'idle', undefined, undefined, { context: 'insert' });

    Vim[已装配] = true;
    return true;
  }

  const api = {
    build: build,
    installEx: installEx,
    hostKeys: hostKeys,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).editorVim = api;
})();
