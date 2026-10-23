// 编辑区的**按键转发**（`design/0012` §2.3-4 / §2.3-5）。
//
// # 这个文件解决的是什么
//
// 编辑区一聚焦，`keymap.js` 的 `handleKeydown` / `dispatch` 就整体 `return false`
// （`ctx.editable()` 见焦点在 `contenteditable` 里）⇒ **应用快捷键整表失效**。
// 这在阅读态是对的（`INV-SET-05`：别在输入框里抢键），在编辑态是错的：
// 用户在编辑一份文件时按 `⌘S` / `⌘F` / `⌘O`，期望的还是**应用**的动作。
//
// ⇒ 编辑区里要有一层**有序转发链**（§2.3-3）：
//
//   ① 应用键（白名单，本节）  →  `Prec.low`
//   ② 编辑器局部键（`historyKeymap` 那 5 条）  →  CM6 默认优先级
//
// ⚠️⚠️ **Vim 插槽不在这条 `Prec` 谱上**（`design/0014` §1.1 的更正块，2026-10-16）：
//   本注释原写「Vim 插槽（将来）→ `Prec.higher`」——**那句已作废，两重错**：
//   ① `Prec` 没有 `higher` 这个成员（只有 `highest/high/default/low/lowest`）⇒ 写下去是 `TypeError`；
//   ② 就算有也轮不到：上游 Vim 挂的是 `EditorView` 的**原生 keydown handler**，
//      ⛔ **不在 `keymap` 这个 facet 里** ⇒ `Prec` 对它毫无影响。
//   ⭐ **真正决定次序的是扩展在 `editor/main.js::extensions()` 数组里的位置**
//      （Vim 那个 `Compartment` 排在转发扩展**之前**）——见 `design/0014` §1.1。
//
// ⛔⛔ **本文件里没有第二份键位表**（`INV-SET-01` / `INV-EDIT-09`）：
//   白名单**从 `rmd.keymap.table` 派生**，⛔ 源码里不出现按键字面量。
//   ⚠️ 这条是可测的：`tests/js/keymap.test.js` 的三条源码级闸门对 `src/editor/**` 一样生效
//   （排除清单**只有** `vendor/cm6.bundle.js` 那一个产物）。
//
// ⚠️ 与 `src/` 下每个文件一样包一层 IIFE（经典脚本的顶层 `const` 共享全局词法作用域，
//    撞名会让**整个文件不执行**且 stderr 全静默——2026-10-13 真踩过）。
(function () {
  'use strict';

  const K = (typeof module !== 'undefined' && module.exports)
    ? require('../services/keymap.js')
    : window.rmd.keymap;

  /** 我们那套修饰键拼写（`splitAccel` 的 `mods`）→ CM6 认的拼写。 */
  const CM6_MOD = { cmd: 'Mod', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl' };

  /**
   * ⭐ **"不按 Shift 就能敲出来"的字符集**——这是转发能不能成立的**唯一**判据。
   *
   * # 为什么必须有它（而不是"照着 `splitAccel` 拼出来就行"）
   *
   * ⚠️ 已从产物里逐行核实（`src/vendor/cm6.bundle.js:12100` `runHandlers`）。
   * CM6 的匹配串**不是**从 `e.key` 直译的，它按这三条分支走：
   *
   * ```text
   * ①  modifiers(keyName(event), event, !isChar)                       ← 首选
   * ②  isChar && (alt||meta||ctrl) && base[keyCode] != name
   *      → modifiers(base[keyCode], event, true)                      ← 换小写字母再来一次
   * ③  isChar && shiftKey → modifiers(name, event, true)              ← 补上 Shift
   * ```
   *
   * 而 `keyName(event)`（`:3743`）在 **mac 且 `metaKey && shiftKey && !ctrl && !alt`** 时
   * **整块忽略 `event.key`**，改用 `(shift ? shiftTbl : baseTbl)[keyCode]`——
   * 也就是"这个**物理键**不按 Shift 时是什么字符"。
   *
   * ⇒ 后果：**一个"非按 Shift 敲不出来"的字符，永远不可能作为 `Meta-X` 被查到**。
   *   例：`Cmd++`（键名是 `+`）看起来能拼成 `Meta-+`，可实际按 `⇧⌘=`
   *   时这一步算出的是 `=` ⇒ 查的是 `Meta-=` / `Shift-Meta-=`，`Meta-+` **一次都不会被查到**。
   *   表现是「按下去什么都不发生」，而白名单里明明白白有这一项——**静默失效**。
   *
   * ⭐ 集合的取值域**恰好**是 CM6 自己那张 `base[]` 表（`:3735` 那片赋值）会产出的字符：
   *    `a-z`（字母）、`0-9`、以及美式布局上**不按 Shift** 就能打出的那一排符号。
   *   ⚠️ 它**不是**键盘布局表：我们比对的是**字符**，不是物理位置——
   *   与 `keymap.js::isShiftImplied` 同一条纪律（那边也说了"不需要布局表"）。
   *
   * ⚠️⚠️ **别用 `keymap.js::isShiftImplied` 当这条判据**（我第一版就是这么写的，是错的）：
   *    `isShiftImplied(',')` 与 `isShiftImplied('=')` 都是 `true`
   *    （它问的是"字符本身要不要 Shift 才能**比对**"，`e.key` 那套模型里 `,`/`=` 不算），
   *    可 `⌘,` / `⌘=` 在 CM6 里**明明是可达的**（`Meta-,` / `Meta-=`）。
   *    拿它当闸门会把字号三键里的两个**误杀**，而 §2.3-6 要求它们在编辑区照旧生效。
   *    ⇒ 两套模型（`e.key` 比对 vs CM6 的 `keyName` 归一）**必须分开判**。
   */
  // ⚠️⚠️ 这个字符类里**故意没有**反引号与单引号，两个理由缺一不可：
  //
  //    ① **测量工具**：源码级闸门那份 `stripComments`（`tests/js/keymap.test.js`）
  //       是按"引号成对"逐字符扫的，它**认不出正则字面量** ⇒ 类里放一个裸反引号
  //       会让它从那里起把后面整片当成字符串，于是**注释不被挖空**、闸门开始误报
  //       （2026-10-15 实测：本文件第 78 / 108 行两条**注释**被判成"键位数据"）。
  //    ② **代价为零且不静默**：那两个键真被写进 `accel` 时，`toCM6Spec` 返回 `null`
  //       ⇒ 进 `deriveWhitelist` 的 `skipped`，**逐条响亮报出来**，⛔ 不是悄悄不转发。
  //       ⚠️ 而 macOS 的快捷键惯例里根本没有这两个键，所以这一步今天不损失任何东西。
  //    ⛔ 不要为了"完整性"把它们加回来——那会让上面①重新发生。
  const 免Shift = /^[a-z0-9\-=\[\]\\;,.\/]$/;

  /**
   * 把一条 `accel` 翻成 CM6 的键位串（`"Cmd+S"` → `"Mod-s"`）。
   *
   * @returns {string|null} `null` = **翻不出来**（键名非按 Shift 敲不出来）⇒ 调用方**响亮报错**。
   *          ⛔ 不返回一个"看着像"的串：那正是上面那段说的静默失效。
   */
  function toCM6Spec(accel) {
    const parts = K.splitAccel(accel);
    if (!parts.key) return null;
    // ⚠️ 字母折小写（`keymap.js::normalizeKey` 的规则，与 `e.key` 那一侧同一份）。
    //    CM6 的 `normalizeKeyName` **不折小写**，所以大写会得到一个永远查不到的串。
    const key = K.normalizeKey(parts.key);
    if (!免Shift.test(key)) return null;
    const mods = [];
    parts.mods.forEach(function (m) {
      const n = CM6_MOD[m];
      if (n && mods.indexOf(n) < 0) mods.push(n);
    });
    // ⚠️ 顺序无所谓（`normalizeKeyName` 会把修饰段重排成 `Shift-Ctrl-Alt-Meta-`），
    //    但**必须**用 `-` 连接 ⇒ 这里⛔ 不出现任何按键字面量。
    return mods.concat([key]).join('-');
  }

  /**
   * ⭐ **转发白名单：从 `rmd.keymap.table` 派生**（§2.3-4 的三条判据）。
   *
   * 1. `owner === 'web'`（`owner = menu` 的由 AppKit 处理；转发它反而是"收起来又弹回去"）；
   * 2. `accel` 含 `cmd`；
   * 3. ⛔ `accel` **不含 `ctrl`** —— 决策 3「预留 Ctrl 组合键」落到代码上的那一个动作。
   *
   * ⚠️ 只认**规范 `accel`**，⛔ 不认 `aliases`：设计原文点名的是 `accel`。
   *    ⚠️ 落到真表上，被丢掉的别名**只有两个**：`Cmd++`（`reader.font-inc`）与
   *    `Cmd+_`（`reader.font-dec`）——它们本来就翻不出 CM6 串（见 `免Shift` 那段，
   *    `+` 与 `_` 都非按 Shift 敲不出来）⇒ 进 `skipped`，**逐条报出来**，⛔ 不静默。
   *    ⚠️⚠️ **它们的规范形式照旧生效**（`⌘=` / `⌘-` 在 CM6 里可达：`Meta-=` / `Meta--`，
   *    `normalizeKeyName` 的 `split(/-(?!$)/)` **保住尾位那个 `-`** —— 已从产物逐行核实）。
   *    ⇒ 这两族动作在**两种模式**里都能用，只是少了一条**别名**入口。
   *
   *    ⚠️ **未核实**：别名那两条丢掉之后，"按 `⇧⌘=` 会不会落到 `⌘=` 上"这件事
   *    **没有实测过**。按 `runHandlers`（产物 `:12100`）的三条分支推演，它会依次查
   *    `Meta-+` → `Shift-Meta-=` → 不再往下走 ⇒ **推演结果是"不会"**。
   *    ⛔ 但这只是读代码推的，⛔ **别把它当成已核实的事实**写进文档。
   *    对产品的实际影响：`⌘=` / `⌘-` 在 macOS 上**本来就不需要按 Shift**，
   *    所以这条路径丢的只是"按住 Shift 敲 `=` 也认"这一个便利。已登记进 §10。
   *
   * @returns {{specs: Array<{id:string,accel:string,spec:string}>, skipped: Array<object>, notes: Array<object>}}
   *   · `specs`   —— 真的要注册进 CM6 的（**空 = 派生写错了**，由 `edit_ok` 的自证挡住）；
   *   · `skipped` —— ⛔ **不许静默**：本该转发却翻不出来的，逐条报；
   *   · `notes`   —— 设计**已明说**的代价（带 Ctrl 的项），只登记，不当错误。
   */
  function deriveWhitelist(table) {
    const specs = [];
    const skipped = [];
    const notes = [];
    (table || []).forEach(function (row) {
      if (!row || row.owner !== 'web') return;
      const accel = row.accel;
      if (!accel) {
        // ⚠️ 这一条 `keymap.js::buildBindings` 也会响亮报（它使得规范键静默失效）。
        skipped.push({ id: row.id, accel: '', why: 'owner=web 却没有 accel —— 没有可断言的规范键' });
        return;
      }
      const parts = K.splitAccel(accel);
      if (!parts.key) {
        skipped.push({ id: row.id, accel: accel, why: 'accel 解析不出键名' });
        return;
      }
      if (parts.mods.indexOf('ctrl') >= 0) {
        // ⭐ **决策 3 的落点，刻意不转发**（§2.3-4 的代价清单）。
        //    ⛔ 这不是"忘了"：将来启用 Vim 之后**也不转发**（Ctrl 组合留给它）。
        notes.push({ id: row.id, accel: accel, why: '含 ctrl —— 刻意不转发（决策 3 预留）' });
        return;
      }
      if (parts.mods.indexOf('cmd') < 0) {
        // ⚠️ 不在设计的三条判据里，但**必须报**：`keymap.js` 的匹配器**照样会**命中它
        //    （`matchAccel` 只要求 `metaKey` 的有无与 `accel` 一致）⇒ 阅读态能按、编辑态按不动，
        //    一个**只在这两种模式之间**才看得见的分叉。
        skipped.push({ id: row.id, accel: accel, why: '不含 cmd —— 阅读态能按、编辑态按不动（分叉）' });
        return;
      }
      const spec = toCM6Spec(accel);
      if (spec === null) {
        skipped.push({
          id: row.id,
          accel: accel,
          why: '键名「' + K.splitAccel(accel).key + '」非按 Shift 敲不出来 ⇒ CM6 查不到这个串（静默失效）',
        });
        return;
      }
      specs.push({ id: row.id, accel: accel, spec: spec });
    });
    return { specs: specs, skipped: skipped, notes: notes };
  }

  /**
   * ⭐ **`ctx.editable()` 垫片**：不改 `keymap.js` 一行，改**传进去的那个 `ctx`**（§2.3-5）。
   *
   * 转发时置一个进程内标志 ⇒ `ctx.editable()` 返回 `false` ⇒ `dispatch` 放行。
   * ⭐ 于是 `dispatch` 的两道校验（**表内 id** ＋ **handler 存在性**）照旧生效，
   *    ⛔ 只是把"焦点在编辑区"这一条**在白名单命中时**让开。
   *
   * ⚠️⚠️ **标志必须在 `try/finally` 里复位**：抛异常时留在 `true`，
   *    会让应用快捷键在**普通文本框**里也全部复活——那正是 `INV-SET-05` 要挡的事。
   *
   * ⚠️ `compositionActive` **不另起一份实现**：直接读真实那个 keymap 实例上的
   *    `composition`（`keymap.js` 把它挂在返回的 api 上，`{active: bool}`）。
   *    ⛔ 别在这里再加一对 `compositionstart/end` 监听——那就是**第二份组合态**，
   *    两份迟早会分叉，而分叉的表现正是 `INV-SET-05` 那条闸漏掉（中文输入中按 `⌘S` 存了盘）。
   *
   * @param {object} [opts]
   * @param {object} [opts.win] 注入的 `window`（单测用）
   */
  function createForwardShim(opts) {
    const conf = opts || {};
    const win = conf.win || (typeof window !== 'undefined' ? window : null);
    let forwarding = false;
    let km = null;

    const ctx = {
      compositionActive: function () {
        // ⚠️ 实例还没绑上时 `false`：那时 `dispatch` 结构上还不可能被调到（`attach()` 更晚）。
        return !!(km && km.composition && km.composition.active);
      },
      editable: function () {
        if (forwarding) return false;
        return K.isEditableElement(win && win.document && win.document.activeElement);
      },
    };

    return {
      ctx: ctx,
      /** 把真实那个 keymap 实例记下来（**只为读它的 `composition`**，⛔ 不缓存别的东西）。 */
      bind: function (instance) { km = instance; },
      /** 转发一次应用动作。⚠️ 走的是**同一个** `keymap.dispatch`（`INV-SET-02`）。 */
      forward: function (id) {
        if (!km) {
          console.error('按键转发：keymap 还没绑上就来转发了 —— 表里的动作「' + id + '」按不动');
          return false;
        }
        forwarding = true;
        try {
          return km.dispatch(id, 'key');
        } finally {
          forwarding = false;
        }
      },
      /** ⚠️ **只为单测**：垫片有没有卡在 `true` 上（卡住 = 普通输入框里应用键全部复活）。 */
      isForwarding: function () { return forwarding; },
    };
  }

  /**
   * 把白名单注册进 CM6（`Prec.low`）。
   *
   * ⚠️ **`Prec.low` 只决定"在本层里排多后"**，⛔ 与 Vim 的先后无关——
   *    上游 Vim 走原生 keydown handler，次序由 `main.js::extensions()` 的**数组位置**定
   *    （见文件头那条更正块）。⭐ `low` 这一档本身是对的：应用转发**必须**排在
   *    编辑器局部键（`historyKeymap`，CM6 默认优先级）**之后**。
   *
   * ⚠️ **`run` 恒返回 `true`**：与阅读态对齐——`keymap.js` 是"命中就 `preventDefault`
   *    **再** dispatch"（`keymap.js:216`），所以"handler 不存在"也不该让浏览器接过这个键。
   *    ⛔ 少了这一条，编辑区里按 `⌘P` 会弹出 WebKit 的打印对话框、`⌘F` 会弹出它自己的查找条
   *    ——两个**浏览器默认行为**在同一批键上。
   *
   * @param {object} CM6 `window.rmdCM6`
   * @param {Array} specs [`deriveWhitelist`] 的 `specs`
   * @param {Function} forward `(id) => boolean`
   */
  function buildBindings(CM6, specs, forward) {
    const list = (specs || []).map(function (row) {
      return {
        key: row.spec,
        run: function () { forward(row.id); return true; },
      };
    });
    return CM6.Prec.low(CM6.keymap.of(list));
  }

  const api = {
    免Shift: 免Shift,
    toCM6Spec: toCM6Spec,
    deriveWhitelist: deriveWhitelist,
    createForwardShim: createForwardShim,
    buildBindings: buildBindings,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).editorKeys = api;
})();
