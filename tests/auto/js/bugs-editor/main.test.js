// 编辑面装配：扩展白名单/顺序、唯一脏来源、重挂光标夹取、Vim 槽位只走 reconfigure、三合一自证。
// 本文件从 docs/bugs 的历史缺陷出发，守住「改了字预览不跟上 / 换文档炸编辑面 / Vim 切换丢历史」。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load() {
  const src = fs.readFileSync(path.join(ROOT, 'src/editor/main.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd.editor;
}

const M = load();

function makeDoc(s) {
  return {
    length: s.length,
    toString: function () { return s; },
  };
}

/**
 * 最小 CM6 fake：只实现 `src/editor/main.js` 真正碰到的成员。
 * ⛔ 不模拟 DOM、不模拟事务合并——只记录「编辑面要求 CM6 做什么」。
 */
function makeFakeCM6(over) {
  const o = over || {};
  const views = [];
  const states = [];
  function Compartment() {
    this.payloads = [];
    this.reconfigs = [];
  }
  Compartment.prototype.of = function (x) {
    this.payloads.push(x);
    return { kind: 'compartment', compartment: this, payload: x };
  };
  Compartment.prototype.reconfigure = function (x) {
    this.reconfigs.push(x);
    return { kind: 'reconfigure', compartment: this, payload: x };
  };

  function EditorView(config) {
    this.state = config.state;
    this.parent = config.parent;
    this.destroyed = false;
    this.composing = false;
    this.calls = [];
    this.scrollDOM = o.noScrollDOM ? null : { scrollTop: 0 };
    views.push(this);
  }
  EditorView.prototype.destroy = function () { this.destroyed = true; };
  EditorView.prototype.dispatch = function (tr) {
    this.calls.push(tr);
    if (tr && tr.changes && o.applyChanges !== false) {
      const old = this.state.doc.toString();
      const from = tr.changes.from || 0;
      const insert = tr.changes.insert || '';
      this.state.doc = makeDoc(old.slice(0, from) + insert + old.slice(from));
    }
  };
  EditorView.lineWrapping = { type: 'lineWrapping' };
  EditorView.updateListener = {
    of: function (fn) { return { type: 'updateListener', fn: fn }; },
  };

  const CM6 = {
    EditorView: EditorView,
    EditorState: {
      create: function (cfg) {
        const state = {
          doc: makeDoc(cfg.doc == null ? '' : cfg.doc),
          selection: cfg.selection,
          extensions: cfg.extensions,
        };
        states.push(state);
        return state;
      },
    },
    Compartment: Compartment,
    Prec: { low: function (x) { return { type: 'low', value: x }; } },
    keymap: { of: function (x) { return { type: 'keymap', value: x }; } },
    lineNumbers: function () { return { type: 'lineNumbers' }; },
    history: function () { return { type: 'history' }; },
    markdown: function () { return { type: 'markdown' }; },
    historyKeymap: [{ key: 'Mod-z' }],
    vim: function (opts) { return [{ type: 'vim', opts: opts }]; },
    Vim: { defineEx: function () {} },
  };
  CM6.views = views;
  CM6.states = states;
  return CM6;
}

function makeHost() {
  const listeners = Object.create(null);
  const add = [];
  const remove = [];
  return {
    listeners: listeners,
    add: add,
    remove: remove,
    addEventListener: function (type, fn) {
      add.push(type);
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener: function (type, fn) {
      remove.push(type);
      const arr = listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    fire: function (type) {
      (listeners[type] || []).slice().forEach(function (fn) { fn(); });
    },
    count: function (type) { return (listeners[type] || []).length; },
  };
}

function makeEditor(over) {
  const o = over || {};
  const CM6 = o.CM6 || makeFakeCM6(o);
  const host = o.host || makeHost();
  const dirty = [];
  const docChanged = [];
  let built = 0;
  let vimExt = o.vimExt || [{ type: 'vim-ext' }];
  const editor = M.createEditor({
    CM6: CM6,
    host: host,
    onDirtyChange: function (d) { dirty.push(d); },
    onDocChanged: function () { docChanged.push(1); },
    buildVim: o.buildVim === undefined
      ? function () { built++; return vimExt; }
      : o.buildVim,
  });
  return {
    editor: editor,
    CM6: CM6,
    host: host,
    dirty: dirty,
    docChanged: docChanged,
    built: function () { return built; },
    view: function () { return editor.raw(); },
  };
}

function updateExt(CM6) {
  return CM6.states[CM6.states.length - 1].extensions[5];
}

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0004（编辑态改了字，预览不会自动跟上，界面上也没有任何提示）
// ——————————————————————————————————————————————————————————————

test('扩展白名单恰好 8 项：六件固定件 ＋ Vim 槽位 ＋ 转发扩展', () => {
  const CM6 = makeFakeCM6();
  const out = M.extensions(CM6, { onDocChanged: function () {} }, { type: 'forward' });
  assert.strictEqual(out.length, 8);
});

test('扩展顺序写死：软换行 → 行号 → history → historyKeymap → markdown → updateListener → Vim → 转发', () => {
  const CM6 = makeFakeCM6();
  const forward = { type: 'forward' };
  const out = M.extensions(CM6, { onDocChanged: function () {} }, forward, { type: 'vimSlot' });
  assert.strictEqual(out[0], CM6.EditorView.lineWrapping);
  assert.strictEqual(out[1].type, 'lineNumbers');
  assert.strictEqual(out[2].type, 'history');
  assert.strictEqual(out[3].type, 'keymap');
  assert.strictEqual(out[4].type, 'markdown');
  assert.strictEqual(out[5].type, 'updateListener');
  assert.strictEqual(out[6].type, 'vimSlot');
  assert.strictEqual(out[7], forward);
});

test('转发扩展必须是最后一位（Vim 之前，历史键之后）', () => {
  const CM6 = makeFakeCM6();
  const forward = { type: 'forward' };
  const out = M.extensions(CM6, {}, forward);
  assert.strictEqual(out[out.length - 1], forward);
});

test('historyKeymap 排在转发扩展之前：CM6 默认优先级先于 Prec.low', () => {
  const CM6 = makeFakeCM6();
  const out = M.extensions(CM6, {}, { type: 'forward' });
  const hist = out.findIndex(function (x) { return x.type === 'keymap'; });
  const fwd = out.findIndex(function (x) { return x.type === 'forward'; });
  assert.ok(hist >= 0 && hist < fwd);
});

test('不传 Vim 槽位时补一个空数组占位，⛔ 不把这一项整个省掉', () => {
  const CM6 = makeFakeCM6();
  const out = M.extensions(CM6, {}, { type: 'forward' });
  assert.deepStrictEqual(out[6], []);
  assert.strictEqual(out[7].type, 'forward');
});

test('updateListener 只在 docChanged 时通知 onDocChanged', () => {
  const CM6 = makeFakeCM6();
  const seen = [];
  const out = M.extensions(CM6, { onDocChanged: function () { seen.push(1); } }, {});
  const fn = out[5].fn;
  fn({ docChanged: false, selectionSet: true, focusChanged: true });
  assert.deepStrictEqual(seen, []);
  fn({ docChanged: true });
  assert.deepStrictEqual(seen, [1]);
});

test('updateListener 不把 selectionSet / focusChanged 算成「有未保存改动」', () => {
  const CM6 = makeFakeCM6();
  const seen = [];
  const out = M.extensions(CM6, { onDocChanged: function () { seen.push(1); } }, {});
  const fn = out[5].fn;
  fn({ selectionSet: true });
  fn({ focusChanged: true });
  assert.deepStrictEqual(seen, []);
});

test('hooks 缺省时 updateListener 不抛错（自证/空壳装配也能过）', () => {
  const CM6 = makeFakeCM6();
  const out = M.extensions(CM6, null, {});
  assert.doesNotThrow(function () { out[5].fn({ docChanged: true }); });
});

test('不碰设计明令禁装的扩展（basicSetup / drawSelection 那一家）', () => {
  const CM6 = makeFakeCM6();
  for (const name of ['basicSetup', 'drawSelection', 'highlightActiveLine', 'defaultKeymap']) {
    Object.defineProperty(CM6, name, {
      get: function () { throw new Error('不该访问 ' + name); },
    });
  }
  assert.doesNotThrow(function () {
    M.extensions(CM6, {}, { type: 'forward' });
  });
});

test('⭐ 每一次缓冲改动都调 onDocChanged，不因「已经脏了」而停（0004 的根因）', () => {
  const a = makeEditor();
  a.editor.mount('', {});
  const fn = updateExt(a.CM6).fn;
  fn({ docChanged: true });
  fn({ docChanged: true });
  fn({ docChanged: true });
  assert.strictEqual(a.docChanged.length, 3);
});

test('onDirtyChange 只在脏布尔翻转时响：3 次改动只报一次 true', () => {
  const a = makeEditor();
  a.editor.mount('', {});
  const fn = updateExt(a.CM6).fn;
  fn({ docChanged: true });
  fn({ docChanged: true });
  fn({ docChanged: true });
  assert.deepStrictEqual(a.dirty, [true]);
});

test('两个消费者缺一不可：onDocChanged 三次、onDirtyChange 一次', () => {
  const a = makeEditor();
  a.editor.mount('', {});
  const fn = updateExt(a.CM6).fn;
  fn({ docChanged: true });
  fn({ docChanged: true });
  fn({ docChanged: true });
  assert.deepStrictEqual([a.docChanged.length, a.dirty.length], [3, 1]);
});

test('缓冲修订号每次 docChanged +1（保存的清脏重判靠它）', () => {
  const a = makeEditor();
  a.editor.mount('', {});
  assert.strictEqual(a.editor.revision(), 0);
  updateExt(a.CM6).fn({ docChanged: true });
  updateExt(a.CM6).fn({ docChanged: true });
  assert.strictEqual(a.editor.revision(), 2);
});

test('markClean 把当前修订记成干净，并只播报一次 dirty=false', () => {
  const a = makeEditor();
  a.editor.mount('', {});
  updateExt(a.CM6).fn({ docChanged: true });
  a.editor.markClean();
  assert.strictEqual(a.editor.isDirty(), false);
  assert.deepStrictEqual(a.dirty, [true, false]);
});

test('markClean 之后还能再变脏：不是一次性开关', () => {
  const a = makeEditor();
  a.editor.mount('', {});
  const fn = updateExt(a.CM6).fn;
  fn({ docChanged: true });
  a.editor.markClean();
  fn({ docChanged: true });
  assert.strictEqual(a.editor.isDirty(), true);
  assert.deepStrictEqual(a.dirty, [true, false, true]);
});

test('markDirty 把外部换进来的、与磁盘不同的缓冲打开脏标记', () => {
  const a = makeEditor();
  a.editor.mount('', {});
  assert.strictEqual(a.editor.isDirty(), false);
  a.editor.markDirty();
  assert.strictEqual(a.editor.isDirty(), true);
  assert.deepStrictEqual(a.dirty, [true]);
});

test('markDirty 之后 markClean 再 markDirty，仍然每次都能重新变脏', () => {
  const a = makeEditor();
  a.editor.mount('', {});
  a.editor.markDirty();
  a.editor.markClean();
  a.editor.markDirty();
  assert.strictEqual(a.editor.isDirty(), true);
  assert.deepStrictEqual(a.dirty, [true, false, true]);
});

test('未挂载时 isDirty / text 都有安全默认值，不抛', () => {
  const a = makeEditor();
  assert.strictEqual(a.editor.isMounted(), false);
  assert.strictEqual(a.editor.isDirty(), false);
  assert.strictEqual(a.editor.text(), '');
  assert.strictEqual(a.editor.revision(), 0);
});

test('mount 后文本来自缓冲，revision 清零', () => {
  const a = makeEditor();
  a.editor.mount('hello', {});
  assert.strictEqual(a.editor.text(), 'hello');
  assert.strictEqual(a.editor.revision(), 0);
  assert.strictEqual(a.editor.isMounted(), true);
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
// ——————————————————————————————————————————————————————————————

test('重挂同一份文档时按旧选区恢复：anchor / head 原样夹取后传入新 state', () => {
  const a = makeEditor();
  a.editor.mount('abcdef', {});
  a.view().state.selection = { main: { anchor: 2, head: 5 } };
  a.editor.mount('abcdef', {}, { keepCursor: true });
  const st = a.CM6.states[a.CM6.states.length - 1];
  assert.deepStrictEqual(st.selection, { anchor: 2, head: 5 });
});

test('重挂更短的文档时选区夹进新长度，⛔ 不让 EditorState 抛越界异常', () => {
  const a = makeEditor();
  a.editor.mount('abcdef', {});
  a.view().state.selection = { main: { anchor: 4, head: 6 } };
  a.editor.mount('xy', {}, { keepCursor: true });
  const st = a.CM6.states[a.CM6.states.length - 1];
  assert.deepStrictEqual(st.selection, { anchor: 2, head: 2 });
});

test('重挂时负偏移与非有限值都夹成 0（isFinite 先于越界判断）', () => {
  const a = makeEditor();
  a.editor.mount('abcdef', {});
  a.view().state.selection = { main: { anchor: -5, head: Infinity } };
  a.editor.mount('abcdef', {}, { keepCursor: true });
  const st = a.CM6.states[a.CM6.states.length - 1];
  assert.deepStrictEqual(st.selection, { anchor: 0, head: 0 });
});

test('keepCursor 只在重挂时传：换文档不传 ⇒ 新 state 没有继承旧选区', () => {
  const a = makeEditor();
  a.editor.mount('abcdef', {});
  a.view().state.selection = { main: { anchor: 2, head: 5 } };
  a.editor.mount('new-doc', {});
  const st = a.CM6.states[a.CM6.states.length - 1];
  assert.strictEqual(st.selection, undefined);
});

test('旧 view 没有 selection.main 时快照为 null，新 state 不编造 0/0', () => {
  const a = makeEditor();
  a.editor.mount('abcdef', {});
  a.view().state.selection = null;
  a.editor.mount('abcdef', {}, { keepCursor: true });
  const st = a.CM6.states[a.CM6.states.length - 1];
  assert.strictEqual(st.selection, undefined);
});

test('重挂前先取快照：destroy 之后 scrollTop 读不到的问题被结构性避开', () => {
  const a = makeEditor();
  a.editor.mount('abcdef', {});
  a.view().state.selection = { main: { anchor: 1, head: 1 } };
  a.view().scrollDOM.scrollTop = 37;
  a.editor.mount('abcdef', {}, { keepCursor: true });
  // 新 view 的 scrollTop 被设成快照值，说明快照是在旧 view 还活着时取的。
  assert.strictEqual(a.view().scrollDOM.scrollTop, 37);
});

test('旧 view 没有 scrollDOM 时快照 scrollTop=null，新挂载不写 scrollTop', () => {
  const a = makeEditor({ noScrollDOM: true });
  a.editor.mount('abcdef', {});
  a.view().state.selection = { main: { anchor: 1, head: 1 } };
  a.editor.mount('abcdef', {}, { keepCursor: true });
  assert.doesNotThrow(function () { a.editor.scrollDOM(); });
});

test('每次 mount 都建新的 Compartment（旧实例属于已销毁的 state）', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  const first = a.CM6.states[0].extensions[6].compartment;
  a.editor.mount('b', {});
  const second = a.CM6.states[1].extensions[6].compartment;
  assert.notStrictEqual(first, second);
});

test('unmount 会销毁 view；重复 unmount 返回 false 且不重复销毁', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  const v = a.view();
  assert.strictEqual(a.editor.unmount(), true);
  assert.strictEqual(v.destroyed, true);
  assert.strictEqual(a.editor.unmount(), false);
});

test('unmount 在「曾经脏过」时补播 dirty=false，调用方的脏镜像不会卡在 true', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  updateExt(a.CM6).fn({ docChanged: true });
  a.editor.unmount();
  assert.deepStrictEqual(a.dirty, [true, false]);
});

test('unmount 在干净时不播报，避免无事实的确认框', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  a.editor.unmount();
  assert.deepStrictEqual(a.dirty, []);
});

test('compositionend 监听与 mount/unmount 成对：重复进出不堆监听器', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  a.editor.unmount();
  a.editor.mount('b', {});
  a.editor.unmount();
  a.editor.mount('c', {});
  assert.strictEqual(a.host.count('compositionend'), 1);
  a.editor.unmount();
  assert.strictEqual(a.host.count('compositionend'), 0);
});

test('mount 重置修订与脏状态，不继承上一份文档的未保存标记', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  updateExt(a.CM6).fn({ docChanged: true });
  a.editor.unmount();
  a.editor.mount('b', {});
  assert.strictEqual(a.editor.isDirty(), false);
  assert.strictEqual(a.editor.revision(), 0);
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0096（probe-vim-keys 的三条判据漂移与撤销栈状态污染）
// ——————————————————————————————————————————————————————————————

test('Vim 关闭时 buildVim 一次都不调（取值函数是惰性的）', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  assert.strictEqual(a.built(), 0);
  assert.deepStrictEqual(a.CM6.states[0].extensions[6].payload, []);
});

test('mount(vimOn=true) 才调 buildVim，槽位里放它返回的扩展', () => {
  const ext = [{ id: 'vim' }];
  const a = makeEditor({ vimExt: ext });
  a.editor.mount('a', {}, { vimOn: true });
  assert.strictEqual(a.built(), 1);
  assert.strictEqual(a.CM6.states[0].extensions[6].payload, ext);
  assert.strictEqual(a.editor.vimEnabled(), true);
});

test('buildVim 返回 undefined 时按空数组处理，不把 undefined 塞进槽位', () => {
  const a = makeEditor({ buildVim: function () { return undefined; } });
  a.editor.mount('a', {}, { vimOn: true });
  assert.deepStrictEqual(a.CM6.states[0].extensions[6].payload, []);
});

test('setVim(true) 只走 reconfigure：有 effects、⛔ 没有 changes（不造编辑事务）', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  assert.strictEqual(a.editor.setVim(true), true);
  const tr = a.view().calls[0];
  assert.strictEqual(tr.changes, undefined);
  assert.ok(tr.effects);
  assert.strictEqual(a.editor.vimEnabled(), true);
});

test('setVim(true) 后槽位载荷就是 buildVim 的 4 项（原样，不包装）', () => {
  const ext = [{}, {}, {}, {}];
  const a = makeEditor({ vimExt: ext });
  a.editor.mount('a', {});
  a.editor.setVim(true);
  const tr = a.view().calls[0];
  assert.strictEqual(tr.effects.payload, ext);
});

test('setVim(false) 把槽位换回空数组，同样只有 effects', () => {
  const a = makeEditor();
  a.editor.mount('a', {}, { vimOn: true });
  assert.strictEqual(a.editor.setVim(false), true);
  const tr = a.view().calls[0];
  assert.deepStrictEqual(tr.effects.payload, []);
  assert.strictEqual(tr.changes, undefined);
  assert.strictEqual(a.editor.vimEnabled(), false);
});

test('setVim 相同值重复调用返回 false，不再 dispatch', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  a.editor.setVim(true);
  assert.strictEqual(a.editor.setVim(true), false);
  assert.strictEqual(a.view().calls.length, 1);
});

test('buildVim 的结果记忆化：反复开关不会重建扩展（寄存器/宏不换一份）', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  a.editor.setVim(true);
  a.editor.setVim(false);
  a.editor.setVim(true);
  assert.strictEqual(a.built(), 1);
});

test('unmount 后再 mount 仍复用同一份 Vim 扩展（模块级记忆化，⛔ 每份文档重建）', () => {
  const ext = [{ id: 'vim' }];
  const a = makeEditor({ vimExt: ext });
  a.editor.mount('a', {}, { vimOn: true });
  a.editor.unmount();
  a.editor.mount('b', {}, { vimOn: true });
  assert.strictEqual(a.built(), 1);
  assert.strictEqual(a.CM6.states[1].extensions[6].payload, ext);
});

test('未挂载时 setVim 只记账、返回 false，不造 view', () => {
  const a = makeEditor();
  assert.strictEqual(a.editor.setVim(true), false);
  assert.strictEqual(a.view(), null);
  assert.strictEqual(a.built(), 0);
});

test('⚠️ 疑似缺陷：未挂载时 setVim 的记账会被下一次 mount 的 vimOn 缺省值冲掉', () => {
  const a = makeEditor();
  a.editor.setVim(true);              // 记账：用户想要开
  a.editor.mount('a', {});            // 调用方没显式传 vimOn ⇒ 要Vim=false
  assert.strictEqual(a.editor.vimEnabled(), false);
  assert.deepStrictEqual(a.CM6.states[0].extensions[6].payload, []);
});

test('组合态中 setVim 只置 pending：不 dispatch、已应用值不变', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  a.view().composing = true;
  assert.strictEqual(a.editor.setVim(true), false);
  assert.strictEqual(a.view().calls.length, 0);
  assert.strictEqual(a.editor.vimEnabled(), false);
  assert.strictEqual(a.editor.vimTogglePending(), true);
});

test('compositionend 后补上被推迟的切换，pending 清空', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  a.view().composing = true;
  a.editor.setVim(true);
  a.view().composing = false;
  a.host.fire('compositionend');
  assert.strictEqual(a.view().calls.length, 1);
  assert.strictEqual(a.editor.vimEnabled(), true);
  assert.strictEqual(a.editor.vimTogglePending(), null);
});

test('compositionend 到达时仍在组合态：继续保持 pending，不换扩展', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  a.view().composing = true;
  a.editor.setVim(true);
  a.host.fire('compositionend');
  assert.strictEqual(a.view().calls.length, 0);
  assert.strictEqual(a.editor.vimTogglePending(), true);
});

test('没有 pending 时 compositionend 是 no-op', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  a.host.fire('compositionend');
  assert.strictEqual(a.view().calls.length, 0);
});

test('unmount 清掉 pending 与已应用值，不给新 state 留旧账', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  a.view().composing = true;
  a.editor.setVim(true);
  a.editor.unmount();
  assert.strictEqual(a.editor.vimTogglePending(), null);
  assert.strictEqual(a.editor.vimEnabled(), false);
});

test('mount(vimOn=false) 明确覆盖未挂载时的旧记账', () => {
  const a = makeEditor();
  a.editor.setVim(true);
  a.editor.mount('a', {}, { vimOn: false });
  assert.strictEqual(a.editor.vimEnabled(), false);
  assert.deepStrictEqual(a.CM6.states[0].extensions[6].payload, []);
});

test('mount(vimOn=true) 与旧记账一致时也不重复 build', () => {
  const a = makeEditor();
  a.editor.setVim(true);
  a.editor.mount('a', {}, { vimOn: true });
  assert.strictEqual(a.built(), 1);
});

test('setVim 只在 reconfigure 一步改扩展，⛔ 不用 setState 重建 EditorState', () => {
  const a = makeEditor();
  a.editor.mount('a', {});
  const stateBefore = a.view().state;
  a.editor.setVim(true);
  assert.strictEqual(a.view().state, stateBefore);
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0107（格子里的按键偶尔「什么都没发生」：编辑面四处静默失败）
// ——————————————————————————————————————————————————————————————

test('自证成功：CM6 在 / 文本往返逐字相等 / 转发含保存键 / Vim 装配面在', () => {
  const CM6 = makeFakeCM6();
  const doc = { createElement: function () { return { tag: 'div' }; } };
  const out = M.selfTest(CM6, [{ id: 'file.save', spec: 'Mod-s' }], doc);
  assert.strictEqual(out.ok, true);
  assert.match(out.note, /CM6 在/);
  assert.match(out.note, /文本往返逐字相等/);
  assert.match(out.note, /转发 1 项/);
  assert.match(out.note, /Vim 装配面在/);
});

test('自证失败：bundle 没加载（window.rmdCM6 不在）', () => {
  const doc = { createElement: function () { return {}; } };
  const out = M.selfTest(null, [{ spec: 'Mod-s' }], doc);
  assert.strictEqual(out.ok, false);
  assert.match(out.note, /bundle 没加载/);
});

test('自证失败：EditorView / EditorState / Prec 缺一', () => {
  for (const key of ['EditorView', 'EditorState', 'Prec']) {
    const CM6 = makeFakeCM6();
    CM6[key] = undefined;
    const out = M.selfTest(CM6, [{ spec: 'Mod-s' }], { createElement: function () { return {}; } });
    assert.strictEqual(out.ok, false, key);
    assert.match(out.note, /导出面不对/);
  }
});

test('自证失败：bundle 里没有 keymap.of', () => {
  const CM6 = makeFakeCM6();
  CM6.keymap = {};
  const out = M.selfTest(CM6, [{ spec: 'Mod-s' }], { createElement: function () { return {}; } });
  assert.strictEqual(out.ok, false);
  assert.match(out.note, /没有 keymap/);
});

test('自证失败：没有 document，建不出临时容器', () => {
  const CM6 = makeFakeCM6();
  const out = M.selfTest(CM6, [{ spec: 'Mod-s' }], null);
  assert.strictEqual(out.ok, false);
  assert.match(out.note, /没有 document/);
});

test('自证失败：临时 EditorView 的文本往返不等，报告写进去 / 读回的字数', () => {
  const CM6 = makeFakeCM6({ applyChanges: false });
  const out = M.selfTest(CM6, [{ spec: 'Mod-s' }], { createElement: function () { return {}; } });
  assert.strictEqual(out.ok, false);
  assert.match(out.note, /文本往返不等/);
  assert.match(out.note, /读回 0 字/);
});

test('自证无论成败都销毁临时 view（漏掉就是每次自证漏一个 view）', () => {
  const okCM6 = makeFakeCM6();
  M.selfTest(okCM6, [{ spec: 'Mod-s' }], { createElement: function () { return {}; } });
  assert.strictEqual(okCM6.views[0].destroyed, true);

  const badCM6 = makeFakeCM6({ applyChanges: false });
  M.selfTest(badCM6, [{ spec: 'Mod-s' }], { createElement: function () { return {}; } });
  assert.strictEqual(badCM6.views[0].destroyed, true);
});

test('自证失败：转发白名单为空（派生写错 ⇒ 编辑区所有应用键失效）', () => {
  const CM6 = makeFakeCM6();
  const out = M.selfTest(CM6, [], { createElement: function () { return {}; } });
  assert.strictEqual(out.ok, false);
  assert.match(out.note, /白名单是空的/);
});

test('自证失败：白名单非空但没有 Mod-s（保存键没了）', () => {
  const CM6 = makeFakeCM6();
  const out = M.selfTest(CM6, [{ spec: 'Mod-f' }, { spec: 'Mod-a' }], { createElement: function () { return {}; } });
  assert.strictEqual(out.ok, false);
  assert.match(out.note, /没有保存键/);
  assert.match(out.note, /共 2 项/);
});

test('自证失败：bundle 里没有 vim（开关会点了没反应）', () => {
  const CM6 = makeFakeCM6();
  delete CM6.vim;
  const out = M.selfTest(CM6, [{ spec: 'Mod-s' }], { createElement: function () { return {}; } });
  assert.strictEqual(out.ok, false);
  assert.match(out.note, /没有 `vim`/);
});

test('自证失败：bundle 里没有 Vim.defineEx（`:w` 会静默 no-op）', () => {
  const CM6 = makeFakeCM6();
  CM6.Vim = {};
  const out = M.selfTest(CM6, [{ spec: 'Mod-s' }], { createElement: function () { return {}; } });
  assert.strictEqual(out.ok, false);
  assert.match(out.note, /没有 `Vim.defineEx`/);
});

test('自证用临时容器，不碰 #editor、不碰当前文档', () => {
  const CM6 = makeFakeCM6();
  const tags = [];
  const doc = {
    createElement: function (tag) { tags.push(tag); return { tag: tag }; },
    getElementById: function (id) { throw new Error('不该按 id 找 ' + id); },
  };
  const out = M.selfTest(CM6, [{ spec: 'Mod-s' }], doc);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(tags, ['div']);
});

test('自证不依赖有没有打开文档：空会话 / 目录模式同样要过', () => {
  const CM6 = makeFakeCM6();
  const doc = { createElement: function () { return {}; } };
  assert.strictEqual(M.selfTest(CM6, [{ spec: 'Mod-s' }], doc).ok, true);
});

test('自证失败不会在界面上留残骸：临时容器自建自弃，不写 parent 之外的节点', () => {
  const CM6 = makeFakeCM6();
  const container = { children: [], tag: 'div' };
  const doc = { createElement: function () { return container; } };
  M.selfTest(CM6, [{ spec: 'Mod-s' }], doc);
  assert.deepStrictEqual(container.children, []);
});
