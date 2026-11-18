// 编辑内核 · IME 组合串 widget（装饰层）。
// 从 `docs/bugs/` 的 0041/0060/0061 倒推：
// 组合串只活在装饰层、文档零变更、同文案复用 DOM、清空后能重画、不把读音当正文。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd;
}

const P = load('src/live/preedit.js').livePreedit;

function fakeCM6() {
  const calls = { widgets: [], sets: [], ranges: [], decos: [], reconfigures: [] };
  class WidgetType {}
  class Compartment {
    constructor() { this.value = undefined; }
    of(v) { this.value = v; return { kind: 'slot', value: v, compartment: this }; }
    reconfigure(v) { this.value = v; calls.reconfigures.push(v); return { kind: 'reconfigure', value: v }; }
  }
  const CM6 = {
    WidgetType: WidgetType,
    Compartment: Compartment,
    Decoration: {
      widget: function (spec) {
        calls.widgets.push(spec);
        return {
          range: function (pos) {
            const r = { kind: 'range', pos: pos, side: spec.side, widget: spec.widget };
            calls.ranges.push(r);
            return r;
          },
        };
      },
      set: function (items, sorted) {
        const s = { kind: 'set', items: items, sorted: sorted };
        calls.sets.push(s);
        return s;
      },
    },
    EditorView: {
      decorations: {
        of: function (x) {
          const d = { kind: 'deco', value: x };
          calls.decos.push(d);
          return d;
        },
      },
    },
  };
  return { CM6: CM6, calls: calls, WidgetType: WidgetType };
}

function fakeView() {
  const v = { dispatches: [] };
  v.dispatch = function (spec) { v.dispatches.push(spec); };
  return v;
}

function withFakeDocument(fn) {
  const made = [];
  const old = globalThis.document;
  globalThis.document = {
    createElement: function (tag) {
      const el = {
        tagName: tag, className: '', textContent: '', attrs: {}, children: [],
        setAttribute: function (k, v) { el.attrs[k] = String(v); },
      };
      made.push(el);
      return el;
    },
  };
  try {
    return fn(made);
  } finally {
    if (old === undefined) delete globalThis.document;
    else globalThis.document = old;
  }
}

// 源自 docs/bugs/0060（拼音与正文叠字）
// 同轴向：组合串是"行内 widget"，不是第二份文档；每次 paint ⛔ 不带 changes。
test('模块加载即可用，create 返回 extension 与 paint', () => {
  assert.strictEqual(typeof P.create, 'function');
  const f = fakeCM6();
  const r = P.create(f.CM6);
  assert.strictEqual(typeof r.paint, 'function');
  assert.strictEqual(r.extension.kind, 'slot');
  assert.deepStrictEqual(r.extension.value, []);
});

test('两个渲染器的装饰槽互相独立', () => {
  const f = fakeCM6();
  const a = P.create(f.CM6);
  const b = P.create(f.CM6);
  assert.notStrictEqual(a.extension, b.extension);
  assert.notStrictEqual(a.extension.compartment, b.extension.compartment);
});

test('首次 paint 的文本：widget 落在给定位置、side=1、经排序 set 装进槽', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'nihao', 12);

  assert.strictEqual(f.calls.widgets.length, 1);
  assert.strictEqual(f.calls.ranges[0].pos, 12);
  assert.strictEqual(f.calls.ranges[0].side, 1);
  assert.strictEqual(f.calls.sets[0].items.length, 1);
  assert.strictEqual(f.calls.sets[0].sorted, true);
  assert.strictEqual(f.calls.sets[0].items[0].kind, 'range');
  assert.strictEqual(f.calls.decos[0].value, f.calls.sets[0]);
  assert.strictEqual(view.dispatches[0].effects.value, f.calls.decos[0]);
});

test('paint 的 dispatch 只有 effects：⛔ 不带 changes / selection（正文零变更）', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, '拼', 3);
  const spec = view.dispatches[0];
  assert.deepStrictEqual(Object.keys(spec), ['effects']);
  assert.strictEqual(spec.changes, undefined);
  assert.strictEqual(spec.selection, undefined);
  assert.strictEqual(spec.scrollIntoView, undefined);
});

test('同一文案连续 paint 不重建 widget、不 dispatch', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'ni', 1);
  r.paint(view, 'ni', 2);
  r.paint(view, 'ni', 3);
  assert.strictEqual(view.dispatches.length, 1);
  assert.strictEqual(f.calls.widgets.length, 1);
  assert.strictEqual(f.calls.ranges[0].pos, 1);
});

test('文案变化才重配，新 widget 带新文本', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'n', 1);
  r.paint(view, 'ni', 1);
  r.paint(view, 'nih', 1);
  assert.strictEqual(view.dispatches.length, 3);
  assert.deepStrictEqual(f.calls.widgets.map((w) => w.widget.text), ['n', 'ni', 'nih']);
});

test('全角字符 / emoji 文案原样进 widget，不做归一或截断', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, '　😀', 0);
  assert.strictEqual(f.calls.widgets[0].widget.text, '　😀');
  assert.strictEqual(f.calls.ranges[0].pos, 0);
});

test('空串 / null / undefined 都清装饰：不建 widget，槽里给空数组', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'ni', 1);
  r.paint(view, '', 1);
  assert.deepStrictEqual(view.dispatches[1].effects.value, []);
  assert.strictEqual(f.calls.widgets.length, 1);
  r.paint(view, null, 1);
  r.paint(view, undefined, 1);
  assert.strictEqual(view.dispatches.length, 2);
});

test('首次就是空串时什么都不做（初值也是空）', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, '', 0);
  r.paint(view, null, 0);
  assert.deepStrictEqual(view.dispatches, []);
  assert.deepStrictEqual(f.calls.reconfigures, []);
});

test('清掉之后同一文案再来会重新建 widget 并重配', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'ni', 1);
  r.paint(view, '', 1);
  r.paint(view, 'ni', 1);
  assert.strictEqual(f.calls.widgets.length, 2);
  assert.strictEqual(view.dispatches.length, 3);
});

test('数字文案按 String 归一，落点照传（含 0）', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 123, 0);
  assert.strictEqual(f.calls.widgets[0].widget.text, '123');
  assert.strictEqual(f.calls.ranges[0].pos, 0);
});

test('文本不做 trim：前后空格是组合串的一部分', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, ' a ', 2);
  assert.strictEqual(f.calls.widgets[0].widget.text, ' a ');
});

// ⚠️ 疑似缺陷：`paint` 的"同文案"判据只看文本、不看落点。组合期间若只发生位置
// 变化（目标偏移被别的提交推开、而 provisional 文本没变），widget ⛔ 不重配，
// 仍停在旧偏移。目前组合期位置通常不动，故钉住现状。
test('只比较文本：同文案换落点不重配（现状：位置不是相等判据）', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'ni', 1);
  r.paint(view, 'ni', 99);
  assert.strictEqual(view.dispatches.length, 1);
  assert.strictEqual(f.calls.ranges[0].pos, 1);
});

test('同一渲染器在同一 view 上画两次不同文案，槽最后一次是 deco', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'a', 0);
  r.paint(view, 'b', 0);
  assert.deepStrictEqual(f.calls.reconfigures.map((x) => (Array.isArray(x) ? x : x.kind)), [
    'deco', 'deco',
  ]);
});

// 源自 docs/bugs/0041（标题下面那一行的拼音按标题字号显示）
// 同轴向：widget 住在 .cm-line 里天然继承行排版；它自己⛔ 不带字号/标题类。
test('widget 只带 cm-rmd-preedit 一个类，⛔ 不自带标题 / 字号类', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, '拼', 5);
  const w = f.calls.widgets[0].widget;
  withFakeDocument(function (made) {
    const el = w.toDOM();
    assert.deepStrictEqual(made, [el]);
    assert.strictEqual(el.tagName, 'span');
    assert.strictEqual(el.className, 'cm-rmd-preedit');
    assert.strictEqual(el.textContent, '拼');
    assert.deepStrictEqual(el.children, []);
    assert.strictEqual(el.attrs['aria-hidden'], 'true');
    assert.strictEqual(el.attrs.style, undefined);
  });
});

test('每次 toDOM 都新建节点，不缓存 DOM', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  r.paint(fakeView(), 'x', 0);
  const w = f.calls.widgets[0].widget;
  withFakeDocument(function (made) {
    const a = w.toDOM();
    const b = w.toDOM();
    assert.notStrictEqual(a, b);
    assert.strictEqual(made.length, 2);
    assert.strictEqual(a.textContent, 'x');
    assert.strictEqual(b.textContent, 'x');
  });
});

test('toDOM 的文本来自构造时的文案，后续别处改文本不影响 widget 自身', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  r.paint(fakeView(), '原', 0);
  const w = f.calls.widgets[0].widget;
  w.text = '改';
  withFakeDocument(function () {
    assert.strictEqual(w.toDOM().textContent, '改');
  });
});

test('widget 不接收事件：ignoreEvent 恒 true', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  r.paint(fakeView(), 'x', 0);
  const w = f.calls.widgets[0].widget;
  assert.strictEqual(w.ignoreEvent(), true);
  assert.strictEqual(w.ignoreEvent({ type: 'mousedown' }), true);
});

test('widget 的 eq 只比文本：同文案 / 不同文案 / 空值', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  r.paint(fakeView(), 'ni', 1);
  const w = f.calls.widgets[0].widget;
  assert.strictEqual(w.eq({ text: 'ni' }), true);
  assert.strictEqual(w.eq({ text: 'ni', side: 9 }), true);
  assert.strictEqual(w.eq({ text: 'n' }), false);
  assert.strictEqual(w.eq({}), false);
  assert.strictEqual(w.eq(null), false);
  assert.strictEqual(w.eq(undefined), false);
  assert.strictEqual(w.eq('ni'), false);
});

test('widget 是 CM6.WidgetType 的实例（交给 CM6 的装饰系统）', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  r.paint(fakeView(), 'x', 0);
  assert.strictEqual(f.calls.widgets[0].widget instanceof f.WidgetType, true);
});

test('两个渲染器在同一 view 上各画各的，slot 不串', () => {
  const f = fakeCM6();
  const a = P.create(f.CM6);
  const b = P.create(f.CM6);
  const view = fakeView();
  a.paint(view, 'x', 0);
  b.paint(view, 'y', 1);
  assert.strictEqual(view.dispatches.length, 2);
  assert.strictEqual(view.dispatches[1].effects.kind, 'reconfigure');
  assert.notStrictEqual(view.dispatches[0].effects.value, view.dispatches[1].effects.value);
});

// 源自 docs/bugs/0061（组合期间粘贴的内容在空组合结束后丢失）
// 同轴向：清空组合串 ≠ 可以丢后续输入；widget 清掉后必须能再次画出来。
test('组合串清空再出现同文案：清空那一次 dispatch 必须真的把槽重配成空', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, '拼', 2);
  r.paint(view, '', 2);
  assert.deepStrictEqual(view.dispatches[1].effects.value, []);
  r.paint(view, '拼', 2);
  assert.strictEqual(f.calls.decos.length, 2);
  assert.strictEqual(f.calls.widgets.length, 2);
});

test('组合串内容不变但组合结束清空：只发生一次重置', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'x', 0);
  r.paint(view, '', 0);
  r.paint(view, '', 0);
  assert.strictEqual(view.dispatches.length, 2);
});
