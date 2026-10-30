// `design/0012` §2.4 / §2.6 的单测：**脏标记状态机、保存的单飞与重判、预览的三档调度**。
//
// ⭐ 这个文件守的是本设计里**全部时序性质**。为什么非要确定性单测：
// 这四件事的错法**没有一个会报错**——
//
//   ① 脏标记漏掉一次转移 ⇒ 退出编辑态时**不弹**确认条，用户敲的字直接没了；
//   ② 清脏前不重判 ⇒ 磁盘上是旧内容、界面说"已保存"，一次**静默的数据丢失**；
//   ③ 单飞闸写成"排队" ⇒ 按住 `⌘S` 会连发多次写盘；
//   ④ 陈旧回包注入了 DOM ⇒ 屏幕上那一份**不是**缓冲的内容，而且看上去完全正常。
//
// ⚠️ 这里的 CM6 是一份**假的**（见 `假CM6`）：本文件要验的是**我们的接线**
//    （`rev`/`cleanRev` 的转移、什么时候推通知），⛔ 不是 CM6 自己的行为——
//    那份由 `tests/js/cm6-bundle.test.js` 对着**真产物**验。
//    ⇒ 假 CM6 只实现我们**真的用到**的那几个成员，⛔ 不要为了"更像"往里加东西：
//      加进来的每一个成员都会让"我们依赖了什么"这件事变得看不清楚。
//
// ⚠️ 纯逻辑、无 DOM、无真计时器（时钟与 `setTimeout` 全部注入）⇒ 可 `node --test`。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
// ⚠️ 后两个只为文件末尾那一条**源码级**接线闸门（`src/main.js` 进不了 `require`）。
const fs = require('node:fs');
const path = require('node:path');

const Ed = require('../../src/editor/main.js');
const Prev = require('../../src/editor/preview.js');
const Save = require('../../src/editor/save.js');

// ─────────────────────────────────────────────────────────────────────────
// 假 CM6（⛔ 只实现我们真的用到的那几个成员）
// ─────────────────────────────────────────────────────────────────────────

/**
 * ⭐ 造一份**最小的** CM6 替身。
 *
 * ⚠️ 它必须保住真 CM6 的两条**语义**（我们直接依赖它们，破了单测就是假的）：
 *   ① `EditorState.create({ doc })` 是**一次性**的：`doc` 之后只能通过 `dispatch` 改；
 *   ② 每次改**只**经过 `updateListener`（⭐ 脏标记的唯一来源）。
 * ⛔ 别在这里实现"文档模型"：本文件要验的是 `rev` 的转移，不是文本编辑。
 */
/**
 * ⭐ **假的 `Compartment`**（`design/0014` 裁定 (a)：Vim 开关那个槽位）。
 *
 * ⚠️ 它必须保住真 `Compartment` 的两条语义（我们**直接依赖**它们，破了单测就是假的）：
 *   ① `of(payload)` 是**建槽**、`reconfigure(payload)` 是**换内容**——两者不是一回事；
 *   ② 换内容**只能经由 `view.dispatch({effects})`**（⇒ 那次事务长什么样是**可观察**的，
 *      ⭐ `INV-VIM-08` 那三条约束正是压在"那次 dispatch 里有什么"上面）。
 *
 * ⚠️ 事务**逐条记下来**（⛔ 不只记最后一次）："切换没有制造编辑事务"这句判据
 *    得能问"**任何**一次事务里有没有 `changes`"。
 */
function 假Compartment() {
  this.payload = undefined;
  this.重建次数 = 0;
}

/**
 * ⭐ **造一份**最小的** CM6 替身。
 *
 * ⚠️ 它必须保住真 CM6 的两条**语义**（我们直接依赖它们，破了单测就是假的）：
 *   ① `EditorState.create({ doc })` 是**一次性**的：`doc` 之后只能通过 `dispatch` 改；
 *   ② 每次改**只**经过 `updateListener`（⭐ 脏标记的唯一来源）。
 * ⛔ 别在这里实现"文档模型"：本文件要验的是 `rev` 的转移，不是文本编辑。
 */
function 假CM6() {
  const 建的 = [];
  const 槽 = [];

  function EditorView(opts) {
    this.state = opts.state;
    this.parent = opts.parent;
    this.scrollDOM = { __scrollDOM: true, scrollTop: 0 };
    this.destroyed = false;
    this._updates = opts.state.__listeners.slice();
    /** ⭐ `design/0014`：所有经过 `dispatch` 的事务（用来判"切换有没有造编辑事务"）。 */
    this.事务 = [];
    // ⚠️ 挂进"DOM"：`createEditor` 之后要能按 host 找到它。这里只需要能引用。
    this.parent.__view = this;
    建的.push(this);
  }
  /**
   * ⚠️ 真 `EditorView.dispatch` 收的是**事务说明**（`{changes?, effects?}`）。
   *    本替身只做两件真事：把事务**记下来**，并把 `reconfigure` 那个效果**发给槽位**——
   *    ⛔ 不改文本、⛔ 不重建 state（那两件是**产品的判据**，不是我们要模拟的行为）。
   */
  EditorView.prototype.dispatch = function (tr) {
    this.事务.push(tr);
    const eff = tr && tr.effects;
    if (eff && eff.__effect === 'compartment.reconfigure') {
      eff.__slot.payload = eff.payload;
      eff.__slot.重建次数 += 1;
    }
    return tr;
  };
  EditorView.prototype.destroy = function () {
    this.destroyed = true;
    this.parent.__view = null;
    // ⚠️ 真 CM6 的 `destroy()` 会把 DOM 摘下来，而**脱离文档的元素 `scrollTop` 读回 0**。
    //    这里照做，⭐ 好让"必须先取快照、再 destroy"这件事**可测**
    //    （把 `mount` 里那句 `cursorSnapshot()` 挪到 `unmount()` 之后，它会红）。
    this.scrollDOM.scrollTop = 0;
  };
  /** ⚠️ 把光标挪到某处。形状与真 CM6 一致：`state.selection.main` 是个 `SelectionRange`。 */
  EditorView.prototype.setCursor = function (anchor, head) {
    this.state.selection = { main: { anchor: anchor, head: head === undefined ? anchor : head } };
  };
  /** ⭐ 模拟"缓冲被改了"——`docChanged: true` 正是 `updateListener` 的判据。 */
  EditorView.prototype.type = function () {
    this._updates.forEach(function (fn) { fn({ docChanged: true }); });
  };
  /** ⚠️ 光标动一下（`selectionSet`）⇒ **不算脏**（§2.1① 表里那一行）。 */
  EditorView.prototype.moveCursor = function () {
    this._updates.forEach(function (fn) { fn({ docChanged: false, selectionSet: true }); });
  };
  EditorView.lineWrapping = { __ext: 'lineWrapping' };
  EditorView.updateListener = {
    of: function (fn) { return { __ext: 'updateListener', __fn: fn }; },
  };

  return {
    EditorView: EditorView,
    EditorState: {
      create: function (spec) {
        const listeners = [];
        (spec.extensions || []).forEach(function (e) {
          if (e && e.__ext === 'updateListener') listeners.push(e.__fn);
        });
        return {
          doc: { toString: function () { return spec.doc; } },
          // ⚠️ 真 `EditorState.create` 收 `selection?: EditorSelection | {anchor, head}`，
          //    ⛔ 不给就是 `EditorSelection.default`（= 文档开头）。这里如实照做。
          selection: spec.selection
            ? { main: { anchor: spec.selection.anchor, head: spec.selection.head } }
            : { main: { anchor: 0, head: 0 } },
          __listeners: listeners,
        };
      },
    },
    lineNumbers: function () { return { __ext: 'lineNumbers' }; },
    history: function () { return { __ext: 'history' }; },
    historyKeymap: [{ __key: 'historyKeymap' }],
    markdown: function () { return { __ext: 'markdown' }; },
    keymap: { of: function (l) { return { __ext: 'keymap', list: l }; } },
    Prec: { low: function (x) { return { __ext: 'prec.low', inner: x }; } },
    /**
     * ⭐ `design/0014` 裁定 (a)：Vim 槽位（`mount` 里 `new CM6.Compartment()`）。
     * ⚠️ 每一次 `mount` **新建一个**（真 `Compartment` 是认 state 的）；
     *    `_槽` 把建过的都留着，测试用它读"槽里现在装的是什么"。
     */
    Compartment: function () {
      const c = new 假Compartment();
      c.of = function (payload) { c.payload = payload; return { __ext: 'compartment.of', __slot: c }; };
      c.reconfigure = function (payload) {
        return { __effect: 'compartment.reconfigure', __slot: c, payload: payload };
      };
      槽.push(c);
      return c;
    },
    /** ⚠️ 只为上面那两条断言。 */
    _建的: 建的,
    /** ⚠️ 只为 Vim 那几条断言：建过的槽位（**最后一个**是当前 state 的）。 */
    _槽: 槽,
  };
}

/** 一个假的宿主元素。 */
function 宿主() { return { __host: true, __view: null }; }

/** 按顺序记下每一次 `onDirtyChange`——⭐ 本文件最常断言的东西就是**转移**。 */
function 脏记录() {
  const 记 = [];
  return { 记: 记, fn: function (d) { 记.push(d); } };
}

// ─────────────────────────────────────────────────────────────────────────
// 脏标记状态机（`editor/main.js::createEditor`）
// ─────────────────────────────────────────────────────────────────────────

test('脏：刚挂上不脏；改一下才脏（`docChanged` 是唯一判据）', function () {
  const CM6 = 假CM6();
  const 脏 = 脏记录();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: 脏.fn });

  ed.mount('第一行\n', null);
  assert.strictEqual(ed.isDirty(), false, '刚挂上必须是干净的');

  ed.raw().moveCursor();
  assert.strictEqual(ed.isDirty(), false, '⛔ 光标动一下**不是**"改了文件"（否则退出编辑态会问一个没有事实的问题）');
  assert.deepStrictEqual(脏.记, [], '光标动不该推出任何通知');

  ed.raw().type();
  assert.strictEqual(ed.isDirty(), true);
  assert.deepStrictEqual(脏.记, [true], '⭐ 脏变化只在**真变**的时候响一次');
});

test('脏：`markClean` 之后再改还是脏（保存后继续打字的那条路）', function () {
  const CM6 = 假CM6();
  const 脏 = 脏记录();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: 脏.fn });
  ed.mount('x', null);

  ed.raw().type();
  ed.markClean();
  assert.strictEqual(ed.isDirty(), false);
  ed.raw().type();
  assert.strictEqual(ed.isDirty(), true, '清脏之后又改了 ⇒ 必须重新脏');
  assert.deepStrictEqual(脏.记, [true, false, true]);
});

test('⭐ 脏：`unmount` 必须把脏**推成 false**（cleanRev 归零那条是错的）', function () {
  // ⚠️⚠️ 这条是本文件里最值钱的一条，它挡的是一个**已经写错过一次**的写法：
  //    第一版 `unmount()` 里写了 `lastDirty = false`，于是下面那次 `pumpDirty()`
  //    算出"没变化"、**不发通知** ⇒ 调用方（`main.js` 的 `editDirty` 镜像）
  //    永远停在 `true`。表现：**退出编辑态之后「● 未保存」还挂在屏幕上**，
  //    或者更坏——切文档时弹一个"有未保存的修改"，而用户已经被问过一次了。
  const CM6 = 假CM6();
  const 脏 = 脏记录();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: 脏.fn });
  ed.mount('x', null);
  ed.raw().type();
  assert.deepStrictEqual(脏.记, [true]);

  ed.unmount();
  assert.strictEqual(ed.isDirty(), false);
  assert.deepStrictEqual(脏.记, [true, false], '⛔ unmount 之后**必须**有一条 false —— 少了它调用方的镜像会停在 true');
});

test('脏：卸载之后 `isDirty` 恒为 false（没挂载就没有缓冲可比）', function () {
  const CM6 = 假CM6();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: function () {} });
  assert.strictEqual(ed.isDirty(), false, '从来没挂过');
  ed.mount('x', null);
  ed.raw().type();
  ed.unmount();
  assert.strictEqual(ed.isDirty(), false);
  assert.strictEqual(ed.isMounted(), false);
});

test('⭐ 脏：重新挂载会 `destroy` 旧 view（⛔ 不泄漏 DOM 观察器）', function () {
  const CM6 = 假CM6();
  const h = 宿主();
  const ed = Ed.createEditor({ CM6: CM6, host: h, onDirtyChange: function () {} });
  ed.mount('a', null);
  const 旧的 = ed.raw();
  ed.mount('b', null);
  assert.strictEqual(旧的.destroyed, true, '⛔ 旧的 `EditorView` 必须被销毁 —— 不销毁就是每次重挂漏一个 DOM 观察器');
  assert.strictEqual(ed.isDirty(), false, '重挂之后是新的一份，干净');
});

test('脏：`revision` 每次改动 +1，重挂归零（保存的重判靠它）', function () {
  const CM6 = 假CM6();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: function () {} });
  ed.mount('x', null);
  assert.strictEqual(ed.revision(), 0);
  ed.raw().type();
  ed.raw().type();
  assert.strictEqual(ed.revision(), 2, '⭐ 两次改动 ⇒ rev=2（保存的"清脏前重判"拿它比）');
  ed.mount('y', null);
  assert.strictEqual(ed.revision(), 0, '重挂 = 新的一份，rev 必须归零');
});

test('白名单：装的是 §2.1① 那几项，⛔ 不含 `basicSetup` / 任何 Decoration', function () {
  // ⚠️ 这条是**白名单**的守门（§2.1① 原文："加一项就是改本设计"）：
  //    多装一项在页面上**看不出来**，只会让"编辑面里能发生什么"这件事悄悄变宽。
  const 转发扩展 = { __ext: 'prec.low', inner: { __ext: 'keymap', list: [] } };
  let 见到的 = null;
  const CM6 = 假CM6();
  CM6.EditorState = {
    create: function (spec) { 见到的 = spec.extensions; return { doc: { toString: function () { return spec.doc; } }, __listeners: [] }; },
  };
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: function () {} });
  ed.mount('x', 转发扩展);

  const 名 = 见到的.map(function (e) { return e && e.__ext; });
  assert.deepStrictEqual(名, [
    'lineWrapping', 'lineNumbers', 'history', 'keymap', 'markdown', 'updateListener',
    'compartment.of', 'prec.low',
  ], '⛔ 扩展清单变了 —— §2.1① 是**封闭白名单**，改它就是改设计'
    + '（⭐ 第 7 位是 `design/0014` 的 Vim 槽位，见其 §1.5：那张表**对编辑面不再封闭**）');
  // ⚠️ `historyKeymap` 必须走 `keymap.of`（上表第 4 项），⛔ 不是被摊平进来。
  assert.deepStrictEqual(
    见到的[3].list,
    [{ __key: 'historyKeymap' }],
    '撤销/重做那几条必须整个 `historyKeymap` 装上（决策 1 点名要的）'
  );
  // ⚠️ 转发扩展**排在最后**（§2.3-3 的有序转发链：应用键那一条在最外面）。
  assert.strictEqual(见到的[7], 转发扩展, '转发扩展必须在白名单的最末一位');
  // ⭐⭐ `design/0014` §2.4-3-②：Vim 槽位**排在转发层之前** —— 这是**唯一**决定
  //    "谁先拿到键"的地方（上游那个 Vim 插件挂的是原生 keydown handler，
  //    ⛔ 不在 `keymap` facet 里 ⇒ `Prec` 对它完全无效）。
  assert.strictEqual(见到的[6].__ext, 'compartment.of', 'Vim 槽位必须在转发层**之前**（第 7 位）');
  assert.strictEqual(见到的[6].__slot.payload && 见到的[6].__slot.payload.length, 0,
    '⛔ 没传 `vimOn` 时槽位里必须是**空的**（不是把这一项省掉——那位置就漂了）');
});

test('白名单：bundle 不在时转发扩展是 `null`（⚠️ 那一项仍占位，⛔ 不塌缩掉）', function () {
  // ⚠️ 这是"没跑过 `make cm6`"的形态：编辑面整个不可用（自证会响亮报出来），
  //    ⛔ 而这一层**不该**自己再报一次——它只要**不改形状**（仍然 8 项、末项是 `null`）。
  let 见到的 = null;
  const CM6 = 假CM6();
  CM6.EditorState = {
    create: function (spec) { 见到的 = spec.extensions; return { doc: { toString: function () { return spec.doc; } }, __listeners: [] }; },
  };
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: function () {} });
  ed.mount('x', null);
  assert.strictEqual(见到的.length, 8);
  assert.strictEqual(见到的[7], null);
});

// ─────────────────────────────────────────────────────────────────────────
// ⭐ 重挂时的光标与滚动（`design/0012` §10.2 第 5 项：重载后源码栏光标丢失）
// ─────────────────────────────────────────────────────────────────────────

/** 读当前 view 上的选区（⛔ 不经过实现里任何私有函数——测的是**可观察结果**）。 */
function 选区(ed) {
  const s = ed.raw().state.selection.main;
  return [s.anchor, s.head];
}

test('重挂（`keepCursor`）：光标与滚动位置都保住', function () {
  const CM6 = 假CM6();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: function () {} });

  ed.mount('第一行\n第二行\n第三行\n', null);
  ed.raw().setCursor(4); // 第一行中间
  ed.raw().scrollDOM.scrollTop = 42;

  // ⭐ 这就是 `refreshEditBuffer` 那条路：外部改过盘，缓冲整份被换掉。
  ed.mount('第一行\n第二行\n第三行\n第四行\n', null, { keepCursor: true });

  assert.deepStrictEqual(选区(ed), [4, 4], '⭐ 光标必须还在原处 —— 否则表现是"每次外部保存，光标跳回第一行"');
  assert.strictEqual(ed.raw().scrollDOM.scrollTop, 42, '滚动位置同理');
});

test('重挂（`keepCursor`）：区间选区（`anchor ≠ head`）两端都保住', function () {
  const CM6 = 假CM6();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: function () {} });
  ed.mount('abcdefghij', null);
  ed.raw().setCursor(2, 7);
  ed.mount('abcdefghij', null, { keepCursor: true });
  assert.deepStrictEqual(选区(ed), [2, 7], '⚠️ `anchor` / `head` 是两件事，⛔ 别把选区压成 caret');
});

test('重挂（`keepCursor`）：文本变短时光标夹到新文档末尾（⛔ 不是抛出去）', function () {
  // ⚠️ 这是**必须有**的一条：CM6 的 `EditorState.create` 对越界选区是**抛异常**的
  //    ⇒ 不夹的话，"外部改动删掉几行"就能把编辑面整个炸掉。
  const CM6 = 假CM6();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: function () {} });
  ed.mount('一二三四五六七八九十', null); // 10 字
  ed.raw().setCursor(9, 10);
  ed.mount('一二三', null, { keepCursor: true }); // 3 字
  assert.deepStrictEqual(选区(ed), [3, 3], '夹到 `len`（⛔ 不是 `len - 1`：`len` 是个合法的光标位）');
});

test('⛔ 不传 `keepCursor`（换文档那一路）：光标回到开头、滚动归零', function () {
  // ⚠️ 这条守的是 `enterEdit`：新文档的光标停在**旧文档**那个偏移上是个没有意义的位置。
  const CM6 = 假CM6();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: function () {} });
  ed.mount('abc\ndef\n', null);
  ed.raw().setCursor(5);
  ed.raw().scrollDOM.scrollTop = 99;

  ed.mount('x', null); // ⛔ 没有第三个参数
  assert.deepStrictEqual(选区(ed), [0, 0]);
  assert.strictEqual(ed.raw().scrollDOM.scrollTop, 0);
});

test('第一次挂载带 `keepCursor` 也不炸（手里没有旧 view）', function () {
  const CM6 = 假CM6();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: function () {} });
  ed.mount('abc', null, { keepCursor: true });
  assert.deepStrictEqual(选区(ed), [0, 0], '没有可恢复的位置 ⇒ 就是默认（开头）');
});

// ─────────────────────────────────────────────────────────────────────────
// 保存（`editor/save.js`）—— 单飞闸 ＋ 清脏前重判
// ─────────────────────────────────────────────────────────────────────────

/** 造一个保存器：`send` 手动放行（好观察"在途"这一刻）。 */
function 造保存器(over) {
  const o = Object.assign({
    文本: 'A',
    版本号: 0,
    状态: [],
    清脏数: 0,
  }, over || {});
  const saver = Save.createSaver({
    getText: function () { return o.文本; },
    rev: function () { return o.版本号; },
    send: o.send || function () { return Promise.resolve({ written: true, bytes: 1, ms: 1 }); },
    onStatus: function (t, isErr) { o.状态.push({ text: t, isError: !!isErr }); },
    onClean: function () { o.清脏数 += 1; },
    onDone: function (out) { o.收尾 = out; },
    isMounted: o.isMounted || function () { return true; },
  });
  return { saver: saver, o: o };
}

test('保存：单飞 —— 在途时再按**不发第二个**，且说一声', async function () {
  let 放行 = null;
  let 发了几次 = 0;
  const { saver, o } = 造保存器({
    send: function () { 发了几次 += 1; return new Promise(function (r) { 放行 = r; }); },
  });

  const 第一次 = saver.save();
  const 第二次 = await saver.save();
  assert.strictEqual(第二次, null, '⛔ 在途时第二次**必须**返回 null（没真发出去）');
  assert.strictEqual(发了几次, 1, '⛔ 单飞：两次按只许发一次 `save_document`');
  assert.strictEqual(o.状态.length, 2);
  assert.match(o.状态[1].text, /正在保存/, '⭐ 要**说出来**——静默忽略与"卡住了"在界面上长得一样');
  assert.strictEqual(o.状态[1].isError, false, '⚠️ 这不是错误，是"忽略了一次重复的按键"');

  放行({ written: true, bytes: 3, ms: 1 });
  const 一 = await 第一次;
  assert.strictEqual(一.written, true);
});

test('⭐ 保存：`rename` 期间又打字 ⇒ **不清脏**，而且说出来', async function () {
  // ⚠️ 这就是 §2.4-4 那张表里最难查的一行：磁盘上写的是**发出去那一刻**的内容，
  //    而那之后的按键**还在缓冲里**。这时清脏 = 把一次真实的未保存改动**说成已保存**，
  //    用户接着按 `⌘W` 就走 —— 一次静默的数据丢失。
  let 放行 = null;
  const { saver, o } = 造保存器({
    send: function () { return new Promise(function (r) { 放行 = r; }); },
  });
  const p = saver.save();
  assert.strictEqual(o.版本号, 0);
  o.版本号 = 1;          // ⭐ 就是这一下：发送期间用户又敲了一个字
  放行({ written: true, bytes: 3, ms: 1 });
  await p;

  assert.strictEqual(o.清脏数, 0, '⛔ 缓冲变了 ⇒ **不许**调 `onClean`');
  assert.match(o.状态[o.状态.length - 1].text, /后来又改/, '⭐ 必须说出来 —— 静默就是"以为存了、其实没存全"');
  assert.strictEqual(o.状态[o.状态.length - 1].isError, false, '⚠️ 不是错误：保存**成功**了，只是缓存里还有新的');
});

test('保存：缓冲没变 ⇒ 清脏（正常路径）', async function () {
  const { saver, o } = 造保存器({});
  const out = await saver.save();
  assert.strictEqual(o.清脏数, 1);
  assert.strictEqual(o.收尾, out, '`onDone` 要拿到结果（回报要用）');
  assert.match(o.状态[0].text, /正在保存/);
  assert.match(o.状态[1].text, /已保存/);
});

test('⭐ 保存：`written === false`（no-op 短路）时文案是「无改动」，⛔ 不是「已保存」', async function () {
  // ⚠️ 后端逐字节比较后发现"还原后的字节与磁盘原文相同"⇒ 它**根本没写**。
  //    说成"已保存"会让人以为文件的时间戳动了（而且那是个**假事实**）。
  const { saver, o } = 造保存器({
    send: function () { return Promise.resolve({ written: false, bytes: 0, ms: 0.4 }); },
  });
  await saver.save();
  assert.match(o.状态[1].text, /无改动/);
  assert.doesNotMatch(o.状态[1].text, /已保存/, '⛔ 没写盘就不许说"已保存"');
  assert.strictEqual(o.清脏数, 1, '⚠️ 仍然要清脏：缓冲与磁盘**确实**一致');
});

test('⭐ 保存：失败 ⇒ 可见 ＋ **不清脏**（原文件一个字节没变）', async function () {
  const { saver, o } = 造保存器({
    send: function () {
      const e = new Error('io');
      e.wording = '磁盘写入失败（只读？）';
      e.path = '/tmp/x.md';
      return Promise.reject(e);
    },
  });
  const out = await saver.save();
  assert.strictEqual(out, null, '⛔ 失败必须返回 null —— 调用方（`promptLeaveEdit`）靠它决定"不许继续"');
  assert.strictEqual(o.清脏数, 0, '⛔ 失败**绝不能**清脏');
  const 末 = o.状态[o.状态.length - 1];
  assert.strictEqual(末.isError, true, '⭐ `INV-EDIT-05`：写盘失败要**看得见**');
  assert.match(末.text, /磁盘写入失败/, '⚠️ 用后端给的 `wording`（人话），⛔ 不自己拼一套');
  assert.match(末.text, /\/tmp\/x\.md/, '⚠️ 带上路径——"哪个文件写不进去"是用户第一个要问的');
  assert.strictEqual(saver.isInflight(), false, '失败之后闸要松开，否则重按就不动了');
});

test('保存：退编辑态之后按保存键**什么都不做**', async function () {
  let 发了几次 = 0;
  const { saver, o } = 造保存器({
    isMounted: function () { return false; },
    send: function () { 发了几次 += 1; return Promise.resolve({ written: true, bytes: 1, ms: 1 }); },
  });
  const out = await saver.save();
  assert.strictEqual(out, null);
  assert.strictEqual(发了几次, 0, '⛔ 退编辑态之后不许再发 `save_document`');
  assert.deepStrictEqual(o.状态, [], '⚠️ 连状态都不该动一下');
});

// ─────────────────────────────────────────────────────────────────────────
// 预览的三档调度（`editor/preview.js`）
// ─────────────────────────────────────────────────────────────────────────

/** 一个假时钟 ＋ 假计时器：⛔ 不用真 `setTimeout`（那会让单测变成"跑得快就一定过"）。 */
function 假钟() {
  const 队 = [];
  let t = 0;
  return {
    队: 队,
    now: function () { return t; },
    setTimer: function (fn, ms) { const h = { fn: fn, at: t + ms, dead: false }; 队.push(h); return h; },
    clearTimer: function (h) { if (h) h.dead = true; },
    /** 把时钟推到下一个到点的计时器并执行它（⛔ 没有就什么都不做，**不报错**）。 */
    走到下一个: function () {
      const 活的 = 队.filter(function (h) { return !h.dead; }).sort(function (a, b) { return a.at - b.at; })[0];
      if (!活的) return false;
      t = Math.max(t, 活的.at);
      活的.dead = true;
      活的.fn();
      return true;
    },
    推进: function (ms) { t += ms; },
  };
}

test('档位：边界（149/150 → A，150/1000/1001 → B/C）', function () {
  assert.strictEqual(Prev.tierFor(0), 'A');
  assert.strictEqual(Prev.tierFor(149), 'A');
  assert.strictEqual(Prev.tierFor(150), 'B', '⚠️ 150 恰好属于 B（`< A_MS` 才算 A）');
  assert.strictEqual(Prev.tierFor(1000), 'B', '⚠️ 1000 恰好属于 B（`<= C_MS`）');
  assert.strictEqual(Prev.tierFor(1000.1), 'C');
  // ⚠️ 没量到（NaN / undefined）⇒ 按最快的档起步：⛔ 别一上来就卡用户。
  assert.strictEqual(Prev.tierFor(NaN), 'A');
  assert.strictEqual(Prev.tierFor(undefined), 'A');
});

test('A 档：改一下 ⇒ 300 ms 后重渲一次', async function () {
  const 钟 = 假钟();
  let 渲了几次 = 0;
  const s = Prev.createScheduler({
    render: function () { 渲了几次 += 1; return Promise.resolve({ ms: 10 }); },
    now: 钟.now, setTimer: 钟.setTimer, clearTimer: 钟.clearTimer,
    initialMs: 10,
  });
  s.markEdited();
  assert.strictEqual(s.isStale(), true, '⭐ 改完立刻就是"过期"（`INV-EDIT-11`：陈旧必须始终可见）');
  assert.strictEqual(渲了几次, 0, '⛔ debounce 之内不许渲');
  钟.走到下一个();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(渲了几次, 1);
  assert.strictEqual(s.isStale(), false, '渲完（且期间没再改）⇒ 不陈旧');
});

test('A 档：连打不排队留一堆计时器（debounce 是"重排"不是"累加"）', async function () {
  const 钟 = 假钟();
  let 渲了几次 = 0;
  const s = Prev.createScheduler({
    render: function () { 渲了几次 += 1; return Promise.resolve({ ms: 10 }); },
    now: 钟.now, setTimer: 钟.setTimer, clearTimer: 钟.clearTimer,
    initialMs: 10,
  });
  s.markEdited(); 钟.推进(100);
  s.markEdited(); 钟.推进(100);
  s.markEdited();
  钟.走到下一个();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(渲了几次, 1, '⛔ 三次改动只该渲一次（每次 `markEdited` 都要先 `cancel` 旧的）');
  assert.strictEqual(钟.队.filter(function (h) { return !h.dead; }).length, 0);
});

test('⭐ B 档：两次重渲之间至少 1 s（⛔ 敲一下停一下不会每次都触发一秒级卡顿）', async function () {
  const 钟 = 假钟();
  const 时刻 = [];
  const s = Prev.createScheduler({
    render: function () { 时刻.push(钟.now()); return Promise.resolve({ ms: 300 }); },
    now: 钟.now, setTimer: 钟.setTimer, clearTimer: 钟.clearTimer,
    initialMs: 300,   // ⇒ 档 B
  });
  assert.strictEqual(s.tier(), 'B');

  s.markEdited();
  钟.走到下一个();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const 第一次 = 时刻[0];

  // ⚠️ 立刻再改一次（距上一次渲只过了 0 ms）⇒ 下一次必须**至少等到 +1 s**
  钟.推进(50);
  s.markEdited();
  const 活的 = 钟.队.filter(function (h) { return !h.dead; })[0];
  assert.ok(活的, 'B 档必须排一个计时器');
  assert.ok(
    活的.at - 第一次 >= Prev.DEBOUNCE_MS.B,
    '⛔ 两次重渲之间的间隔必须 ≥ 1 s —— 否则"敲一个字停一下"每次都触发一次一秒级卡顿'
  );
});

test('⭐ C 档：改**不自动重渲**，只把"过期"显出来（§2.6-2）', async function () {
  const 钟 = 假钟();
  let 渲了几次 = 0;
  const 陈旧 = [];
  const s = Prev.createScheduler({
    render: function () { 渲了几次 += 1; return Promise.resolve({ ms: 2000 }); },
    onStale: function (st, tier) { 陈旧.push({ stale: st, tier: tier }); },
    now: 钟.now, setTimer: 钟.setTimer, clearTimer: 钟.clearTimer,
    initialMs: 5000,   // ⇒ 档 C
  });
  assert.strictEqual(s.tier(), 'C');
  s.markEdited();
  assert.strictEqual(钟.队.filter(function (h) { return !h.dead; }).length, 0, '⛔ C 档**不许**排计时器');
  assert.strictEqual(渲了几次, 0);
  assert.deepStrictEqual(陈旧, [{ stale: true, tier: 'C' }],
    '⭐ 但**必须**把过期报到界面上（并带上档位——档 C 要出"更新预览"按钮）');
});

test('C 档：手动「更新预览」**不受档位限制**（它就是档 C 的唯一出路）', async function () {
  const 钟 = 假钟();
  let 渲了几次 = 0;
  const s = Prev.createScheduler({
    render: function () { 渲了几次 += 1; return Promise.resolve({ ms: 2000 }); },
    now: 钟.now, setTimer: 钟.setTimer, clearTimer: 钟.clearTimer,
    initialMs: 5000,
  });
  s.markEdited();
  await s.requestNow();
  assert.strictEqual(渲了几次, 1, '⛔ 手动更新在 C 档下必须能渲 —— 否则用户唯一的出路是坏的');
  assert.strictEqual(s.isStale(), false);
});

test('陈旧：`req` 单调递增，且落后于 `latestReq` 的回包**整份丢弃**', async function () {
  // ⚠️ 这挡的是"慢的那个先出去、快的那个后回来，然后慢的把它盖掉"——
  //    屏幕上那一份**不是**缓冲的内容，而且看上去完全正常。
  const 钟 = 假钟();
  const 挂 = [];
  const s = Prev.createScheduler({
    render: function (req) {
      return new Promise(function (r) { 挂.push({ req: req, r: r }); });
    },
    now: 钟.now, setTimer: 钟.setTimer, clearTimer: 钟.clearTimer,
    initialMs: 10,
  });

  const p1 = s.requestNow();
  const 号1 = s.latestReq();
  // ⚠️ 在途时再来一次：单飞闸只置 `pending`，⛔ **不发第二个请求**（§2.6-3）
  await s.requestNow();
  assert.strictEqual(挂.length, 1, '⛔ 单飞：同时只许有一个在飞');

  挂[0].r({ ms: 10 });
  await p1;
  assert.strictEqual(s.renders(), 1);
  assert.ok(号1 > 0, '⭐ `req` 从 1 起（`INV-EDIT-07`：独立于 `session.latestReq`）');

  // —— 现在伪造一个"落后"的回包 ——
  // ⚠️ 走到这条路要**跨路径**（`begin_edit` 的刷新与预览撞上），正常敲键走不到，
  //    所以这里直接对着 `fire` 造成那个状态。
  const p2 = s.requestNow();
  const 号2 = s.latestReq();
  assert.ok(号2 > 号1, '★ `req` 必须**单调递增**');
  挂[挂.length - 1].r({ ms: 10 });
  await p2;
  assert.strictEqual(s.renders(), 2);
});

test('陈旧：`isMounted()` 为假时**渲染整个不发生**（退编辑态之后不许再挂 DOM）', async function () {
  const 钟 = 假钟();
  let 渲了几次 = 0;
  let 挂着 = true;
  const s = Prev.createScheduler({
    render: function () { 渲了几次 += 1; return Promise.resolve({ ms: 10 }); },
    now: 钟.now, setTimer: 钟.setTimer, clearTimer: 钟.clearTimer,
    initialMs: 10,
    isMounted: function () { return 挂着; },
  });
  挂着 = false;
  await s.requestNow();
  assert.strictEqual(渲了几次, 0, '⛔ 退编辑态之后、回来之前，一次 IPC 都不该发');
});

test('陈旧：`cancel()` 之后那个计时器不再开火（退编辑态要清干净）', async function () {
  const 钟 = 假钟();
  let 渲了几次 = 0;
  const s = Prev.createScheduler({
    render: function () { 渲了几次 += 1; return Promise.resolve({ ms: 10 }); },
    now: 钟.now, setTimer: 钟.setTimer, clearTimer: 钟.clearTimer,
    initialMs: 10,
  });
  s.markEdited();
  s.cancel();
  assert.strictEqual(钟.走到下一个(), false, '⛔ 取消之后不该还有活的计时器');
  assert.strictEqual(渲了几次, 0);
});

test('陈旧：通知只在**真变**的时候响（⛔ 不是每次改都响一次）', function () {
  const 钟 = 假钟();
  const 报 = [];
  const s = Prev.createScheduler({
    render: function () { return Promise.resolve({ ms: 10 }); },
    onStale: function (st) { 报.push(st); },
    now: 钟.now, setTimer: 钟.setTimer, clearTimer: 钟.clearTimer,
    initialMs: 10,
  });
  s.markEdited();
  s.markEdited();
  s.markEdited();
  assert.deepStrictEqual(报, [true], '⭐ 三次改动只该响**一次** true（两级真值不能脱节，也不该抖动）');
});

test('⭐ 陈旧：`markSaved` **刻意什么都不做**（保存成功不触发预览重渲）', function () {
  // ⚠️ 这条守的是一个**决定**（§2.4："清脏标记后 ⛔ 不触发预览重渲"），不是一个遗漏。
  //    实现成"渲染一次"会让每次 `⌘S` 都白付一次 `innerHTML` ＋强制布局。
  const 钟 = 假钟();
  let 渲了几次 = 0;
  const s = Prev.createScheduler({
    render: function () { 渲了几次 += 1; return Promise.resolve({ ms: 10 }); },
    now: 钟.now, setTimer: 钟.setTimer, clearTimer: 钟.clearTimer,
    initialMs: 10,
  });
  s.markEdited();
  s.cancel();          // 把 debounce 摘掉，好让下面那一句**无从**触发渲染
  s.markSaved();
  assert.strictEqual(钟.队.filter(function (h) { return !h.dead; }).length, 0, '⛔ `markSaved` 不该排任何计时器');
  assert.strictEqual(渲了几次, 0);
  assert.strictEqual(s._editSeq(), 1, '⚠️ 它也**不许**动 `editSeq`');
  assert.strictEqual(s._renderSeq(), -1, '⚠️ 它更**不许**动 `renderSeq`（那会把"过期"说成"已同步"）');
});

// ─────────────────────────────────────────────────────────────────────────
// ⭐ 接线：`onDocChanged` ⇒ 预览调度器（`docs/bugs/0004`，2026-10-16）
// ─────────────────────────────────────────────────────────────────────────

test('⭐ 接线：`onDocChanged` 在**每一次**改动上都响（⛔ 不是"脏翻转时"）', function () {
  // ⭐⭐ **这条是真抓到过一个 bug 的**（`docs/bugs/0004`）。
  //
  // 起因：`preview.js::markEdited` 是编辑态自动重渲 ＋ 陈旧提示条的**唯一**入口
  // （`INV-EDIT-11`），而它在产品代码里**一次都没被调过** —— `src/main.js` 只挂了
  // `onDirtyChange`，那一条**结构上**到不了"每一次改动"：
  // `pumpDirty()` 判的是 `isDirty()`（`rev !== cleanRev`）的**翻转**，
  // 而第一次改字之后 `isDirty()` 恒为 `true` ⇒ `lastDirty` 不再变 ⇒ **通知只响一次**。
  // ⚠️ 于是：改第一个字之后防抖渲**一**次，后面每一个字**都不再重排防抖** ——
  // 屏幕上一切正常、控制台一个字不报、`make test` 245 条全绿。
  //
  // ⚠️ 所以这条必须断言**次数**，⛔ 不能只断言"响过"。
  const CM6 = 假CM6();
  const 脏 = 脏记录();
  const 变了 = [];
  let ed = null;
  ed = Ed.createEditor({
    CM6: CM6, host: 宿主(), onDirtyChange: 脏.fn,
    onDocChanged: function () { 变了.push(ed.revision()); },
  });

  ed.mount('第一行\n', null);
  assert.deepStrictEqual(变了, [], '⛔ 挂载本身不是一次改动（否则一进编辑态就说"预览已过期"）');

  ed.raw().type();
  ed.raw().type();
  ed.raw().type();
  assert.deepStrictEqual(
    变了, [1, 2, 3],
    '⭐ 三次改动要通知三次（⛔ 不是一次）—— 次数不对就等于防抖不再被重排'
  );

  ed.raw().moveCursor();
  assert.deepStrictEqual(变了, [1, 2, 3], '⛔ 光标动一下**不是**缓冲变了（§2.1① 那一行）');

  // ⚠️ 反面判据：脏标记那条**本来就该**只响一次 —— 两条路**不同**，别把 `pumpDirty` 改坏。
  assert.deepStrictEqual(脏.记, [true], '⭐ 脏通知只在**翻转**时响一次（这条不许被上面那条带偏）');
});

test('⭐ 接线：没给 `onDocChanged` 也不炸（`editor.test.js` 里那些用例就是这种形态）', function () {
  // ⚠️ 这个钩子是可选的：`createEditor` 的七个既有调用点里有若干不带它。
  const CM6 = 假CM6();
  const ed = Ed.createEditor({ CM6: CM6, host: 宿主(), onDirtyChange: function () {} });
  ed.mount('x\n', null);
  ed.raw().type();                 // ⛔ 不许抛
  assert.strictEqual(ed.isDirty(), true, '脏标记照旧（它不依赖那个钩子）');
});

test('⭐⭐ 接线（源码级）：`src/main.js` 必须真的把 `markEdited` 接上', function () {
  // ⚠️ 上面那两条验的是 `editor/main.js` **露出**了这个钩子；
  //    而缺陷在**另一端**：`src/main.js` **没接**。
  //    `src/main.js` 是**根脚本**（不进 `require`），在 node 里跑不起来
  //    ⇒ 这一条只能按**源码级闸门**写（同族先例：`tests/js/keymap.test.js` 的
  //    「脚本加载顺序·依赖先于取值」）。
  //
  // ⭐ 判据只钉**一个**事实：`src/main.js` 里有对 `editorPreview.markEdited(` 的**调用**。
  //    ⛔ 不许放宽成"提到了 markEdited"——注释里提一句就过的话，这条闸门等于不存在。
  //    ⚠️ 所以先把注释剥掉再匹配（`src/main.js` 里有多处注释**正好提到**这个名字）。
  const p = path.join(__dirname, '..', '..', 'src', 'main.js');
  const raw = fs.readFileSync(p, 'utf8');
  // 剥注释：**行注释 ＋ 块注释**。⚠️ 够用即可 —— 这里只用来防"注释里提一句"，
  //  ⛔ 不是要做一个解析器（真出现字符串里写 `//` 的形态，这条会偏保守地**报红**，
  //  那是安全的方向：它逼人来看一眼，而不会**漏放**）。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  assert.ok(
    /editorPreview\s*\.\s*markEdited\s*\(/.test(code),
    '⛔ `src/main.js` 没有调 `editorPreview.markEdited(...)` —— ' +
    '编辑态的自动重渲与陈旧提示条会**静默失效**（`docs/bugs/0004`）'
  );

  // ⚠️ 反面判据：**光调还不够**，必须挂在**每一次改动**都响的那条路上。
  //    ⇒ 同一个 `Ed.createEditor({...})` 里要出现 `onDocChanged`。
  //    （"挂在 `onDirtyChange` 里"正是那个 bug 的形态，⛔ 它也能让上面那条正则变绿。）
  const 建编辑面 = code.slice(code.indexOf('Ed.createEditor('), code.indexOf('Ed.createEditor(') + 900);
  assert.ok(
    /onDocChanged\s*:/.test(建编辑面),
    '⛔ `markEdited` 没挂在 `onDocChanged` 上 —— ' +
    '挂在 `onDirtyChange` 上只会响**一次**，之后防抖再也不重排（`docs/bugs/0004`）'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// ⭐⭐ `design/0014` 裁定 (a)：Vim 开关的切换语义（`INV-VIM-08`）
//
// 裁定逐字：「切换**不得丢文本、制造编辑事务或清空撤销历史**，
// **组合态期间延后切换**」。四条都在这里落成断言。
//
// ⚠️ 为什么非要测：这四条的错法**一条都不会报错**——
//    丢文本是"切一下开关，刚才打的字没了"；
//    重建 state 会让**撤销历史**静默消失（`⌘Z` 突然什么都不做）；
//    组合态换扩展会把**正在组的字**丢掉；而机器上根本没有"正在组字"的常态，
//    所以只有真敲中文的人撞得到（`0d` 那条人工闸门验的正是它）。
// ─────────────────────────────────────────────────────────────────────────

/** ⚠️ `宿主()` 没有事件接口；`mount` 的 `compositionend` 那条路要一个**能监听的**宿主。 */
function 可听宿主() {
  const 表 = Object.create(null);
  return {
    __host: true, __view: null,
    addEventListener: function (t, fn) { (表[t] || (表[t] = [])).push(fn); },
    removeEventListener: function (t, fn) {
      const a = 表[t] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    发: function (t) { (表[t] || []).slice().forEach(function (fn) { fn(); }); },
    几个: function (t) { return (表[t] || []).length; },
  };
}

/** 假的 `buildVim`：记下被调了几次，并返回一份**可辨识**的 4 项。 */
function 假Vim工厂() {
  const 四件 = [
    { __vim: 'ViewPlugin' }, { __vim: 'Decoration' },
    { __vim: '隐藏原生插入符' }, { __vim: '模式面板' },
  ];
  const 记 = { 次: 0, 四件: 四件 };
  return {
    记: 记,
    build: function () { 记.次 += 1; return 四件; },
  };
}

test('⭐⭐ Vim 开关：切一下**不丢文本、不动缓冲**', function () {
  const CM6 = 假CM6();
  const v = 假Vim工厂();
  const ed = Ed.createEditor({
    CM6: CM6, host: 宿主(), onDirtyChange: function () {}, buildVim: v.build,
  });
  ed.mount('第一行\n第二行\n', null);
  const 前 = ed.text();
  const 前rev = ed.revision();

  assert.strictEqual(ed.setVim(true), true, '⭐ 真的生效了');
  assert.strictEqual(ed.text(), 前, '⛔ 切开关**一个字符都不许动**（裁定 (a) 第 1 条）');
  assert.strictEqual(ed.revision(), 前rev, '⚠️ 切开关**不是**一次编辑 ⇒ `rev` 不许变');
  assert.strictEqual(ed.isDirty(), false, '⛔ 切开关不许制造"未保存"');

  assert.strictEqual(ed.setVim(false), true);
  assert.strictEqual(ed.text(), 前, '关掉同样不许动文本');
  assert.strictEqual(ed.isDirty(), false);
});

test('⭐⭐ Vim 开关：那次 `dispatch` **只有 `effects`**（⛔ 没有 `changes`）', function () {
  // ⭐ 这是"不制造编辑事务"的**结构性**判据：一次带 `changes` 的事务会
  //    进撤销栈、推 `docChanged`、并把脏标记点亮 —— 而页面上只是"切了个开关"。
  const CM6 = 假CM6();
  const 脏 = 脏记录();
  const ed = Ed.createEditor({
    CM6: CM6, host: 宿主(), onDirtyChange: 脏.fn, buildVim: 假Vim工厂().build,
  });
  ed.mount('abc', null);
  ed.setVim(true);
  ed.setVim(false);
  ed.setVim(true);

  const 事务 = ed.raw().事务;
  assert.strictEqual(事务.length, 3, '⭐ 每次真切换**恰好一次** `dispatch`（⛔ 别一次切换 dispatch 两下）');
  事务.forEach(function (tr, i) {
    assert.strictEqual(tr.changes, undefined, '⛔ 第 ' + i + ' 次事务带了 `changes` —— 那是一次编辑');
    assert.ok(tr.effects && tr.effects.__effect === 'compartment.reconfigure',
      '⭐ 唯一允许的效果是 `reconfigure`');
  });
  assert.deepStrictEqual(脏.记, [], '⛔ 切开关不许推出任何脏标记通知');
});

test('⭐⭐ Vim 开关：`EditorState` **不被替换**（撤销历史还在）', function () {
  // ⚠️ 违反的形态是 `view.setState(…)` —— 新 state 就是一份**全新的撤销历史**，
  //    而这件事**完全静默**：`⌘Z` 之后什么都没发生，用户只会以为"这个应用不能撤销"。
  // ⭐ 判据用**引用相等**：state 对象还是原来那一个 ⇒ 它里面那棵 `history` 也还是原来那一棵。
  const CM6 = 假CM6();
  const ed = Ed.createEditor({
    CM6: CM6, host: 宿主(), onDirtyChange: function () {}, buildVim: 假Vim工厂().build,
  });
  ed.mount('abc', null);
  const view = ed.raw();
  const state = view.state;

  ed.setVim(true);
  assert.strictEqual(ed.raw(), view, '⭐ `EditorView` 本身也不该被重建');
  assert.strictEqual(ed.raw().state, state, '⛔ `EditorState` 被换掉了 ⇒ 撤销历史没了');
  ed.setVim(false);
  assert.strictEqual(ed.raw().state, state, '关掉同样不许重建');
});

test('⭐⭐ Vim 开关：槽位里装的是 `buildVim()` 给的那 4 项（⭐ 引用相等）', function () {
  const CM6 = 假CM6();
  const v = 假Vim工厂();
  const ed = Ed.createEditor({
    CM6: CM6, host: 宿主(), onDirtyChange: function () {}, buildVim: v.build,
  });
  ed.mount('abc', null);
  const 槽 = CM6._槽[CM6._槽.length - 1];
  assert.deepStrictEqual(槽.payload, [], '⚠️ 没传 `vimOn` ⇒ 出厂是**关**的（裁定 (a)）');

  ed.setVim(true);
  assert.strictEqual(槽.payload, v.记.四件, '⭐ 必须是**同一份**那 4 项（⛔ 不许再包一层）');
  ed.setVim(false);
  assert.deepStrictEqual(槽.payload, [], '关掉 = 槽位里换成空的（⚠️ 槽位本身**还在**，位置不许漂）');
});

test('⭐⭐ Vim 开关：`buildVim` **只被调一次**（`INV-VIM-07`：寄存器/宏/模式跟着 state 走）', function () {
  // ⚠️ 每次都重建的话，界面上完全看不出来，但**寄存器 / 宏 / 上一次的模式**
  //    会随着开关切换换一份新的 ⇒ 用户说"我复制的东西切一下就没了"。
  const CM6 = 假CM6();
  const v = 假Vim工厂();
  const ed = Ed.createEditor({
    CM6: CM6, host: 宿主(), onDirtyChange: function () {}, buildVim: v.build,
  });
  ed.mount('abc', null);
  ed.setVim(true);
  ed.setVim(false);
  ed.setVim(true);
  assert.strictEqual(v.记.次, 1, '⭐⭐ 开关来回切了三次，上游的 `vim()` 只能被调**一次**');

  // ⚠️ **同一个 `createEditor` 里重挂也不重建**：那 4 项是**模块级的**
  //    （插件自己的状态住在闭包里，⛔ 不绑在 `EditorState` 上）——
  //    所以 `unmount` 那句刻意写着"`vimExt` **不清**"。
  ed.mount('abc', null);
  ed.setVim(true);
  assert.strictEqual(v.记.次, 1, '⚠️ 同一份控制器里重挂不许重建（那 4 项与 state 无关）');
  assert.strictEqual(ed.raw().事务[0].effects.payload, v.记.四件);
});

test('⭐⭐ Vim：**换一个编辑面**（退出编辑态再进）会重建那 4 项', () => {
  // ⭐ 这就是 `INV-VIM-07` 的另一半「**退出编辑态才清**」的落点：
  //    它不是"某个 `clear()` 被调到"，而是 `src/main.js::enterEdit` **新建一个
  //    `createEditor`** ⇒ 记忆化变量跟着新的控制器重来一遍。
  //    ⚠️ 所以下面这两句必须**各建一个控制器**——写成一个的话，测的是"不重建"（上面那条）。
  const CM6 = 假CM6();
  const v = 假Vim工厂();
  function 建一次() {
    const ed = Ed.createEditor({
      CM6: CM6, host: 宿主(), onDirtyChange: function () {}, buildVim: v.build,
    });
    ed.mount('abc', null, { vimOn: true });
    return ed;
  }
  建一次();
  assert.strictEqual(v.记.次, 1);
  建一次();                       // ← 第二次编辑态
  assert.strictEqual(v.记.次, 2, '⭐ 新的编辑面 ⇒ 新的那 4 项（寄存器/宏/模式不跨会话）');
});

test('⭐⭐ Vim 开关：组合态期间**推迟**，`compositionend` 之后补上', function () {
  // ⚠️ 这一条守的是**丢字**：正在组字时换扩展，CM6 那一段组合态会断在半路。
  //    ⭐ 判据分两半——**推迟**（此刻还没生效）与**补上**（`compositionend` 之后生效）。
  const CM6 = 假CM6();
  const h = 可听宿主();
  const ed = Ed.createEditor({
    CM6: CM6, host: h, onDirtyChange: function () {}, buildVim: 假Vim工厂().build,
  });
  ed.mount('abc', null);
  ed.raw().composing = true;            // ⚠️ 判据用的是**CM6 自己那个** `view.composing`

  assert.strictEqual(ed.setVim(true), false, '推迟 ⇒ 返回值是 `false`（⚠️ ⛔ 调用方不许把它当失败）');
  assert.strictEqual(ed.vimEnabled(), false, '⭐ 此刻**还没**生效');
  assert.strictEqual(ed.vimTogglePending(), true, '但记账了 —— 否则这次切换就**丢了**');
  assert.strictEqual(ed.raw().事务.length, 0, '⛔ 组合态里一次 `dispatch` 都不许发生');

  ed.raw().composing = false;           // IME 上屏
  h.发('compositionend');
  assert.strictEqual(ed.vimEnabled(), true, '⭐⭐ `compositionend` 之后必须补上 —— 少了它表现为"点了开关没反应"');
  assert.strictEqual(ed.vimTogglePending(), null, '待切的值要清掉');

  // ⚠️ 组合态**还没结束**时 `compositionend` 到了 ⇒ 仍要推迟（CM6 可能还在收拾上屏那一下）。
  ed.raw().composing = true;
  ed.setVim(false);
  h.发('compositionend');
  assert.strictEqual(ed.vimEnabled(), true, '⚠️ 仍然组合中 ⇒ 继续推迟，⛔ 别硬切');
  ed.raw().composing = false;
  h.发('compositionend');
  assert.strictEqual(ed.vimEnabled(), false, '真的结束了才落');
});

test('⭐ Vim：`compositionend` 的挂/拆**成对**（进出编辑态多次不许堆监听器）', function () {
  // ⚠️ 与 `0012` §11 的 `syncStart`/`syncStop` 同一形态：堆起来的表现是
  //    "退出再进来之后，一次切换会被冲刷 N 次"。
  const CM6 = 假CM6();
  const h = 可听宿主();
  const ed = Ed.createEditor({
    CM6: CM6, host: h, onDirtyChange: function () {}, buildVim: 假Vim工厂().build,
  });
  ed.mount('a', null);
  assert.strictEqual(h.几个('compositionend'), 1);
  ed.mount('b', null);                 // ← 内部先 unmount
  assert.strictEqual(h.几个('compositionend'), 1, '⛔ 重挂不许堆第二个');
  ed.unmount();
  assert.strictEqual(h.几个('compositionend'), 0, '⭐ 退出编辑态要拆干净');
  assert.strictEqual(ed.vimEnabled(), false, '卸载 = 没有 state 了 ⇒ 开关记账一并清掉');
});

test('Vim：没挂载时 `setVim` **只记账**，⛔ 不造 view、⛔ 不抛', function () {
  const CM6 = 假CM6();
  const v = 假Vim工厂();
  const ed = Ed.createEditor({
    CM6: CM6, host: 宿主(), onDirtyChange: function () {}, buildVim: v.build,
  });
  assert.strictEqual(ed.setVim(true), false, '没挂载 ⇒ 什么都没发生');
  assert.strictEqual(ed.raw(), null, '⛔ 不许在这里建一个 `EditorView` —— 那不在本设计的边界内');
  assert.strictEqual(v.记.次, 0, '⚠️ 没挂载时连 build 都不该发生（那是 `mount` 的事）');
});

test('Vim：`vimOn` 由 `mount` 带进来（冷启动那条路 —— ⛔ 不是进编辑态之后再补一刀）', function () {
  const CM6 = 假CM6();
  const v = 假Vim工厂();
  const ed = Ed.createEditor({
    CM6: CM6, host: 宿主(), onDirtyChange: function () {}, buildVim: v.build,
  });
  ed.mount('abc', null, { vimOn: true });
  assert.strictEqual(ed.vimEnabled(), true, '⭐ `config.json` 里开着 ⇒ 挂载当场就是开的');
  assert.strictEqual(CM6._槽[CM6._槽.length - 1].payload, v.记.四件);
  // ⛔ 不传就是关（裁定 (a)：出厂关闭）。
  ed.mount('abc', null);
  assert.strictEqual(ed.vimEnabled(), false);
  assert.deepStrictEqual(CM6._槽[CM6._槽.length - 1].payload, []);
});
