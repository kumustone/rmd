// `design/0014` 裁定 (b) 的单测：**`:w` 只走既有保存入口**（`INV-VIM-03`）。
//
// 裁定逐字：「`:w` 必须调用**应用既有保存入口**，复用授权、冲突检查及组合态保护；
// **异步保存完成前不能显示成功**，失败不得清除脏标记。不支持的命令明确报错。」
//
// ⭐ 为什么这些必须测：**多开一条写路径**这件事在页面上完全看不出来——
//    它照样能存成功，只是绕过了授权 / 冲突检查 / 单飞闸，
//    而绕过的那一天正是"磁盘上别人的改动被覆盖掉"的那一天。
//    ⛔ 所以判据必须钉在**接线**上（这一条写错了不会有任何报错）。
//
// ⚠️ `src/main.js` 是**根脚本**（不进 `require`）⇒ 接线那几条只能按
//    **源码级闸门**写（同族先例：`tests/js/editor.test.js` 的 `markEdited` 那条、
//    `tests/js/keymap.test.js` 的「脚本加载顺序·依赖先于取值」）。
// ⚠️ 纯逻辑：这里用的是**真的** `installEx` ＋ **真的** `save.js`，⛔ 没有假实现。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EdVim = require('../../src/editor/vim.js');
const Save = require('../../src/editor/save.js');

// ─────────────────────────────────────────────────────────────────────────
// 源码级闸门：`src/main.js` 的接线
// ─────────────────────────────────────────────────────────────────────────

/** 读 `src/main.js` 并**剥掉注释**（⚠️ 只用来防"注释里提一句就过"，⛔ 不是解析器）。 */
function 读main() {
  const p = path.join(__dirname, '..', '..', 'src', 'main.js');
  return fs.readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * ⭐ **裸判据**：给一段源码文本，判它有没有把 `:w` 接到既有保存入口上。
 *
 * ⚠️ 之所以要把判据抽出来（而不是就地写一串正则），是为了让下面那条测试能
 * **拿一份坏源码问它**——否则范围一旦被改窄（比如"只扫 `editor/vim.js`"），
 * 闸门会**照样全绿**。这是 `docs/bugs/0004`/`0005` 那一族留下的纪律。
 *
 * @returns {{ 装了: boolean, 早退: boolean, 走保存器: boolean, 漏出手: string[] }}
 */
function 判接线(code) {
  const i = code.indexOf('EdVim.installEx(');
  if (i < 0) return { 装了: false, 早退: false, 走保存器: false, 漏出手: [] };
  // 取那一段（到配对的 `);` 为止）——⚠️ 用**固定窗口**而不是真配平：
  // 够用即可，而且真出现"窗口里混进了别的东西"时它是**偏保守**的（会多报问题）。
  const 段 = code.slice(i, i + 400);
  const 漏出手 = [];
  // ⛔ 第二条写路径的指纹：绕过 `save.js` 自己发 IPC / 自己拼字段。
  ['invoke(', 'rmd:save', 'save_document', 'write_document', 'writeFile', 'call(']
    .forEach(function (k) { if (段.indexOf(k) >= 0) 漏出手.push(k); });
  return {
    装了: /EdVim\s*\.\s*installEx\s*\(\s*CM6\s*\.\s*Vim\s*,/.test(段),
    // ⚠️ 退出编辑态之后 `editorSave` 是 `null` ⇒ 必须有早退，否则 `:w` 会**抛**
    //    （而 `:w` 抛出去的表现是"Vim 面板卡住"，用户看不到任何解释）。
    早退: /if\s*\(\s*!\s*editorSave\s*\)\s*return/.test(段),
    走保存器: /editorSave\s*\.\s*save\s*\(/.test(段),
    漏出手: 漏出手,
  };
}

test('⭐⭐ 接线（源码级）：`:w` 接的是**既有保存入口**，⛔ 没有第二条写路径', () => {
  const code = 读main();
  const r = 判接线(code);
  assert.ok(r.装了, '⛔ `src/main.js` 没有 `EdVim.installEx(CM6.Vim, …)` —— '
    + '`:w` 会落到上游那个**彻底静默的 no-op** 上（不报错、不写盘，用户以为存了）');
  assert.ok(r.走保存器, '⛔ 那个回调里没有调 `editorSave.save()` —— 授权/冲突检查/单飞闸全被绕过了');
  assert.ok(r.早退, '⛔ 没有 `if (!editorSave) return;` —— 退出编辑态之后按 `:w` 会抛');
  assert.deepStrictEqual(r.漏出手, [], '⛔ 出现了第二条写路径的指纹：' + r.漏出手.join('、'));

  // ⚠️ **恰好一次**：两处 `installEx` ⇒ 后一处覆盖前一处，而前一处那份闭包
  //    可能指向**另一个**保存器（表现是":w 有时候写的是上一次编辑的那份"）。
  const 次 = (code.match(/EdVim\s*\.\s*installEx\s*\(/g) || []).length;
  assert.strictEqual(次, 1, '⛔ `installEx` 在这个文件里只该有一处调用点');
});

test('⭐ 判据自检：拿一份**坏源码**问它，必须逐条变假', () => {
  // ⭐ 这就是"裸判据"的用处：⛔ 没有它，上面那条闸门可能只是一句**空话**
  //    （比如哪天有人把范围改窄、或正则写松了，它照样全绿）。
  const 好 = 'EdVim.installEx(CM6.Vim, function () { if (!editorSave) return; editorSave.save(); });';
  assert.deepStrictEqual(判接线(好), { 装了: true, 早退: true, 走保存器: true, 漏出手: [] },
    '基线（好源码）必须先成立 —— ⚠️ 基线不成立的判据是个**恒假**的判据');

  assert.strictEqual(判接线('EdVim.hostKeys(CM6.Vim);').装了, false, '完整没装 ⇒ 第一项就该假');
  assert.strictEqual(
    判接线('EdVim.installEx(CM6.Vim, function () { editorSave.save(); });').早退, false,
    '摘掉早退闸 ⇒ 早退那项变假');
  assert.strictEqual(
    判接线('EdVim.installEx(CM6.Vim, function () { invoke("save_document", {}); });').走保存器, false,
    '自己发 IPC ⇒ "走保存器"变假');
  assert.deepStrictEqual(
    判接线('EdVim.installEx(CM6.Vim, function () { invoke("rmd:save", {}); });').漏出手,
    ['invoke(', 'rmd:save'], '自造写路径 ⇒ 指纹要报出来');
  assert.strictEqual(
    判接线('EdVim.installEx(CM6.Vim, f); // 第二处\nEdVim.installEx(CM6.Vim, g);').装了, true,
    '⚠️ 这一条**判不出来**（判据只取第一段的窗口）—— 所以"恰好一次"由上面那条单独数，⛔ 不靠它');
});

test('⭐ 接线（源码级）：`vim.js` 里那一步**只调保存器**，⛔ 一个字都不说成功', () => {
  // ⚠️ 裁定 (b)：「异步保存完成前**不能显示成功**」。
  //    上游执行 ex 命令是**同步调用**、紧接着就调 `params.callback()`（见 `vim.js` 的注释）
  //    ⇒ 想在这里报"成功"就必须**自己等**，而那正是 `save.js`（`onStatus`）在做的事。
  //    ⛔ 两个出口 = 状态条上会闪出两句互相矛盾的话。
  const p = path.join(__dirname, '..', '..', 'src', 'editor', 'vim.js');
  const code = fs.readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  // 取 `installEx` 那一段，到文件结束（它后面只剩 `hostKeys`，两者都不该有这些词）。
  const 段 = code.slice(code.indexOf('function installEx'), code.indexOf('function hostKeys'));
  assert.ok(段.length > 100, '⚠️ 没切到 `installEx` 段 —— 判据本身可能已经失效');
  ['await', 'catch', 'onStatus', 'markClean', 'then(', '已保存', '正在保存']
    .forEach(function (k) {
      assert.strictEqual(段.indexOf(k), -1,
        '⛔ `installEx` 里出现了 `' + k + '` —— 在这里报状态就是**第二个出口**，'
        + '而且它会在 promise 落定之前就报出去（裁定 (b)）');
    });
  // ⚠️ 正面那一句必须有（否则上面那些"没有"可以靠**整段删掉**来满足）。
  assert.ok(/save\s*\(\s*\)/.test(段), '⭐ 必须真的有那一跳：调既有的保存器');
});

// ─────────────────────────────────────────────────────────────────────────
// 端到端：真的 `installEx` ＋ 真的 `save.js`
// ─────────────────────────────────────────────────────────────────────────

/** 一份最小的假 `Vim`（`defineEx` 是赋值 ⇒ 重复调不堆叠，与上游一致）。 */
function 假Vim() {
  const 表 = {};
  return {
    defineEx: function (name, short, fn) { 表[name] = fn; },
    exCommands: 表,
  };
}

/** ⭐ 造一条**与 `src/main.js` 同形**的接线：`:w` → 一个"当前保存器"的取值函数。 */
function 接线(saver) {
  const V = 假Vim();
  let 当前 = saver;
  const 写 = EdVim.installEx(V, function () {
    if (!当前) return;
    当前.save();
  });
  return { V: V, 写: 写, 换: function (s) { 当前 = s; } };
}

test('⭐⭐ 端到端：`:w` 真的走到那个 `send`，而且**文案只有 `onStatus` 一个出口**', async () => {
  const 发出去的 = [];
  const 状态 = [];
  const saver = Save.createSaver({
    getText: function () { return '正文'; },
    rev: function () { return 1; },
    send: function (t) {
      发出去的.push(t);
      return Promise.resolve({ written: true, bytes: 6, ms: 3 });
    },
    onStatus: function (t, isErr) { 状态.push({ text: t, isError: !!isErr }); },
    onClean: function () { 状态.push({ text: '(清脏)', isError: false }); },
    isMounted: function () { return true; },
  });

  const w = 接线(saver);
  let 自己报过 = false;
  w.写({}, { callback: function () { 自己报过 = true; } });

  assert.deepStrictEqual(发出去的, ['正文'], '⭐ `:w` 必须真的把当前缓冲发出去');
  assert.strictEqual(自己报过, false, '⛔ `params.callback` 被调了 —— 那是"保存**之前**就报成功"');
  // ⚠️ 此刻还在途（`send` 的 promise 还没落定）⇒ 状态里**不该**有"已保存"。
  assert.strictEqual(状态.some(function (s) { return /已保存/.test(s.text); }), false,
    '⛔ 异步保存完成前不能显示成功（裁定 (b) 逐字）');

  await new Promise(function (r) { setImmediate(r); });
  // ⚠️ 顺序是 `save.js` 的实现事实：**先报结果、再清脏**（`onClean` 在重判之后，
  //    见其第 88-93 行）。⛔ 别把这两句的先后写反——反了会掩盖"重判没过 ⇒ 其实没清"
  //    那个分支（它的文案是"已保存，但你后来又改了"，与正常那条**只差一个分支**）。
  assert.deepStrictEqual(状态.map(function (s) { return s.text; }),
    ['正在保存…', '已保存（6 字节 / 3.0 ms）', '(清脏)'],
    '⭐ 成功那一刻的两句话都来自 `save.js`（⛔ 不是从 `vim.js` 另发一句）');
});

test('⭐⭐ 端到端：`:w` 失败 ⇒ 文案是可见的错误，且**不清脏标记**', async () => {
  const 状态 = [];
  let 清脏 = 0;
  const saver = Save.createSaver({
    getText: function () { return '正文'; },
    rev: function () { return 1; },
    send: function () { return Promise.reject({ wording: '文件被别人改过了', path: '/tmp/a.md' }); },
    onStatus: function (t, isErr) { 状态.push({ text: t, isError: !!isErr }); },
    onClean: function () { 清脏 += 1; },
    isMounted: function () { return true; },
  });

  接线(saver).写({}, {});
  await new Promise(function (r) { setImmediate(r); });

  const 错 = 状态.filter(function (s) { return s.isError; });
  assert.strictEqual(错.length, 1, '⭐ 失败必须**看得见**（`INV-EDIT-05`）');
  assert.ok(/文件被别人改过了/.test(错[0].text), '⚠️ 用的是 `tauri.js` 给的**人话**，⛔ 不是在 Vim 那层另拼一套');
  assert.ok(/\/tmp\/a\.md/.test(错[0].text), '路径要带上（用户得知道是哪个文件）');
  assert.strictEqual(清脏, 0, '⭐⭐ 失败**不许**清脏标记 —— 清了就是"磁盘上是旧的、界面说已保存"');
  assert.strictEqual(状态.some(function (s) { return /已保存/.test(s.text); }), false,
    '⛔ 一个字都不许说"已保存"');
});

test('⭐ 端到端：在途时再按 `:w` ⇒ 复用**同一条单飞闸**（⛔ 不发第二次写）', async () => {
  // ⚠️ 这一条是"复用既有入口"的直接证据：单飞闸在 `save.js` 里，
  //    而 `:w` 走到它 ⇒ `:w` 与 `⌘S` 共享同一道闸（⛔ 不是各一套）。
  let 放行 = null;
  const 发出去的 = [];
  const 状态 = [];
  const saver = Save.createSaver({
    getText: function () { return '正文'; },
    rev: function () { return 1; },
    send: function (t) {
      发出去的.push(t);
      return new Promise(function (r) { 放行 = r; });
    },
    onStatus: function (t) { 状态.push(t); },
    onClean: function () {},
    isMounted: function () { return true; },
  });
  const w = 接线(saver);
  w.写({}, {});
  w.写({}, {});                       // ← 在途时又按了一次 `:w`
  assert.deepStrictEqual(发出去的, ['正文'], '⭐⭐ 第二次被同一道单飞闸挡住 —— 只有一次写');
  assert.ok(状态.indexOf('正在保存，已忽略') >= 0, '⚠️ 挡住了要**说一声**，⛔ 不静默');
  放行({ written: true, bytes: 6, ms: 1 });
  await new Promise(function (r) { setImmediate(r); });
});

test('⭐ 端到端：不在编辑态（取不到保存器）按 `:w` —— 什么都不发生，⛔ 不抛', async () => {
  // ⚠️ `exitEdit` 会把 `editorSave` 置回 `null`，而 `:w` 只在 Vim 装着的编辑面里
  //    才可能被按到 —— 但"正常路径到不了"**不是**不写早退的理由（`docs/bugs/0005` 同族）。
  const w = 接线(null);
  assert.doesNotThrow(function () { w.写({}, {}); }, '⛔ 抛出去的表现是"Vim 面板卡住"，用户看不到任何解释');
});
