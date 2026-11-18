// IME 组合串 widget：文档不变、同文案复用 DOM、空串清掉、每次只重配装饰槽。
// 守的是 `INV-LIVE-04` / `design/0047` §2.7：组合串只活在装饰层。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function load() {
  const src = fs.readFileSync(path.join(ROOT, 'src/live/preedit.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.rmd.livePreedit;
}

const P = load();

function fakeCM6() {
  const calls = {
    widgets: [],
    sets: [],
    ranges: [],
    decosOf: [],
    reconfigures: [],
    dispatches: [],
  };
  class WidgetType {}
  class Compartment {
    constructor() {
      this.value = undefined;
    }
    of(v) {
      this.value = v;
      return { kind: 'slot', value: v, compartment: this };
    }
    reconfigure(v) {
      this.value = v;
      calls.reconfigures.push(v);
      return { kind: 'reconfigure', value: v };
    }
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
          calls.decosOf.push(d);
          return d;
        },
      },
    },
  };
  return { CM6: CM6, calls: calls, WidgetType: WidgetType };
}

function fakeView() {
  const view = {
    dispatches: [],
    dispatch: function (spec) {
      view.dispatches.push(spec);
    },
  };
  return view;
}

test('模块本身不依赖 CM6 即可加载并导出 create', () => {
  assert.strictEqual(typeof P.create, 'function');
});

test('create 返回 extension 与 paint，extension 是空装饰槽', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  assert.strictEqual(typeof r.paint, 'function');
  assert.strictEqual(r.extension.kind, 'slot');
  assert.deepStrictEqual(r.extension.value, []);
});

test('create 不共享状态：两个渲染器各自的空槽互不相干', () => {
  const f = fakeCM6();
  const a = P.create(f.CM6);
  const b = P.create(f.CM6);
  assert.notStrictEqual(a.extension.compartment, b.extension.compartment);
  assert.notStrictEqual(a.extension, b.extension);
});

test('paint 首次收到空串什么都不做（初值也是空）', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, '', 3);
  assert.deepStrictEqual(view.dispatches, []);
  assert.strictEqual(f.calls.reconfigures.length, 0);
});

test('paint 非空串：一个 side=1 的 widget、排序 set、经 decorations.of 装进槽', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'ni', 7);

  assert.strictEqual(f.calls.widgets.length, 1);
  assert.strictEqual(f.calls.widgets[0].widget.text, 'ni');
  assert.strictEqual(f.calls.widgets[0].side, 1);
  assert.deepStrictEqual(f.calls.ranges[0].pos, 7);
  assert.strictEqual(f.calls.ranges[0].side, 1);
  assert.strictEqual(f.calls.sets.length, 1);
  assert.strictEqual(f.calls.sets[0].items.length, 1);
  assert.strictEqual(f.calls.sets[0].sorted, true);
  assert.strictEqual(f.calls.decosOf.length, 1);
  assert.strictEqual(f.calls.decosOf[0].value, f.calls.sets[0]);

  assert.strictEqual(view.dispatches.length, 1);
  assert.deepStrictEqual(Object.keys(view.dispatches[0]), ['effects']);
  assert.strictEqual(view.dispatches[0].effects.kind, 'reconfigure');
  assert.strictEqual(view.dispatches[0].effects.value, f.calls.decosOf[0]);
});

test('同一文案重复 paint 不重建 DOM、不 dispatch', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'ni', 1);
  r.paint(view, 'ni', 2);
  assert.strictEqual(view.dispatches.length, 1);
  assert.strictEqual(f.calls.widgets.length, 1);
  assert.strictEqual(f.calls.ranges[0].pos, 1);
});

test('文案变了才重配，widget 换成新文本', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'n', 1);
  r.paint(view, 'ni', 1);
  assert.strictEqual(view.dispatches.length, 2);
  assert.strictEqual(f.calls.widgets[1].widget.text, 'ni');
});

test('空串 / null / undefined 都清掉装饰，且不建 widget', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'ni', 1);
  assert.strictEqual(f.calls.widgets.length, 1);
  r.paint(view, '', 1);
  assert.strictEqual(f.calls.widgets.length, 1);
  assert.strictEqual(f.calls.sets.length, 1);
  assert.deepStrictEqual(view.dispatches[1].effects.value, []);
  r.paint(view, null, 1);
  r.paint(view, undefined, 1);
  assert.strictEqual(view.dispatches.length, 2);
});

test('清掉之后同一文案再来会重新建 widget', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'ni', 1);
  r.paint(view, '', 1);
  r.paint(view, 'ni', 1);
  assert.strictEqual(f.calls.widgets.length, 2);
  assert.strictEqual(view.dispatches.length, 3);
});

test('数字 / 对象文本按 String 归一，落点原样传给 range', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 123, 0);
  assert.strictEqual(f.calls.widgets[0].widget.text, '123');
  assert.strictEqual(f.calls.ranges[0].pos, 0);
});

test('widget 的 eq 只比文本：同文案复用，别的对象 / 不同文案不复用', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'ni', 1);
  const w = f.calls.widgets[0].widget;
  assert.strictEqual(w.eq({ text: 'ni' }), true);
  assert.strictEqual(w.eq({ text: 'n' }), false);
  assert.strictEqual(w.eq(null), false);
  assert.strictEqual(w.eq(undefined), false);
});

test('widget 的 toDOM 造 aria-hidden 的 cm-rmd-preedit span，不接事件', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, '拼', 2);
  const w = f.calls.widgets[0].widget;
  const made = [];
  const old = globalThis.document;
  globalThis.document = {
    createElement: function (tag) {
      const el = {
        tagName: tag,
        className: '',
        textContent: '',
        attrs: {},
        setAttribute: function (k, v) {
          el.attrs[k] = String(v);
        },
      };
      made.push(el);
      return el;
    },
  };
  try {
    const el = w.toDOM();
    assert.deepStrictEqual(made, [el]);
    assert.strictEqual(el.tagName, 'span');
    assert.strictEqual(el.className, 'cm-rmd-preedit');
    assert.strictEqual(el.textContent, '拼');
    assert.strictEqual(el.attrs['aria-hidden'], 'true');
  } finally {
    if (old === undefined) delete globalThis.document;
    else globalThis.document = old;
  }
  assert.strictEqual(w.ignoreEvent(), true);
});

test('paint 的 dispatch 只有 effects，⛔ 不带 changes / selection（文档一个字节不动）', () => {
  const f = fakeCM6();
  const r = P.create(f.CM6);
  const view = fakeView();
  r.paint(view, 'ni', 5);
  const spec = view.dispatches[0];
  assert.strictEqual(spec.changes, undefined);
  assert.strictEqual(spec.selection, undefined);
  assert.deepStrictEqual(Object.keys(spec), ['effects']);
});

test('多个渲染器同时画同一文案，各自独立 dispatch', () => {
  const f = fakeCM6();
  const a = P.create(f.CM6);
  const b = P.create(f.CM6);
  const va = fakeView();
  const vb = fakeView();
  a.paint(va, 'x', 0);
  b.paint(vb, 'x', 0);
  assert.strictEqual(va.dispatches.length, 1);
  assert.strictEqual(vb.dispatches.length, 1);
  assert.strictEqual(f.calls.widgets.length, 2);
});
