// 跨模块边界：事务恢复、选区空间、快捷键精确匹配、外部事件身份。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const T = require('../../src/live/txn.js');
const K = require('../../src/services/keymap.js');
const R = require('../../src/services/reload.js');

const parts = ['text', 'undo', 'redo', 'identity', 'object', 'selection', 'dom'];
for (const failedPart of [null, ...parts]) {
  test(`事务部分恢复 ${failedPart || '全部成功'}`, () => {
    const state = Object.fromEntries(parts.map(p => [p, p + ':before']));
    const frame = T.createFrame({ txId: 1, revision: { docSeq: 4, commitSeq: 7 } });
    for (const part of parts) frame.add(part, () => state[part], value => {
      if (part === failedPart) throw Error(part);
      state[part] = value;
    });
    for (const part of parts) state[part] = part + ':candidate';
    const out = frame.restore({ txId: 1, revision: { docSeq: 4, commitSeq: 7 } });
    assert.equal(out.ok, failedPart === null);
    assert.deepEqual(out.failed, failedPart ? [failedPart] : []);
    for (const part of parts) assert.equal(state[part], part + (part === failedPart ? ':candidate' : ':before'));
    state.text = '后续输入';
    frame.restore({ txId: 1 });
    assert.equal(state.text, '后续输入', '幂等回滚不能覆盖恢复后的新输入');
  });
}

for (const revision of [{ docSeq: 5, commitSeq: 7 }, { docSeq: 4, commitSeq: 8 }, { docSeq: 5, commitSeq: 0 }]) {
  test(`旧事务拒绝回滚新修订 ${JSON.stringify(revision)}`, () => {
    let value = '原';
    const frame = T.createFrame({ txId: 't', revision: { docSeq: 4, commitSeq: 7 } });
    frame.add('text', () => value, v => { value = v; });
    value = '新文档';
    assert.equal(frame.restore({ txId: 't', revision }).why, 'newer');
    assert.equal(value, '新文档');
    assert.equal(frame.restored, false);
  });
}

for (const space of ['doc', 'block', 'cell']) {
  for (const [anchor, head, expected] of [
    [-9, 99, [0, 10]], [99, -9, [10, 0]], [8, 2, [8, 2]],
    [0, 0, [0, 0]], [10, 10, [10, 10]], [99, 99, [10, 10]],
  ]) {
    test(`选区夹取保方向/空间 ${space}/${anchor}:${head}`, () => {
      const revision = { docSeq: 9, commitSeq: 3 };
      const out = T.clampSelection(T.selection({ anchor, head, space, revision, objectId: '对象' }), 10);
      assert.deepEqual([out.anchor, out.head], expected);
      assert.equal(out.space, space);
      assert.equal(out.objectId, '对象');
      assert.deepEqual(out.revision, revision);
    });
  }
}

const accelerators = [
  ['保存', 'Cmd+S', 's', 1], ['撤销', 'Cmd+Z', 'z', 1],
  ['重做', 'Shift+Cmd+Z', 'z', 9], ['打开文件', 'Shift+Cmd+O', 'o', 9],
  ['外部编辑', 'Shift+Cmd+E', 'e', 9], ['查找', 'Cmd+F', 'f', 1],
];
for (const [name, accel, key, expectedMask] of accelerators) {
  for (let mask = 0; mask < 16; mask++) {
    test(`快捷键修饰键真值表 ${name}/mask=${mask}`, () => {
      const ev = { key, metaKey: !!(mask & 1), ctrlKey: !!(mask & 2), altKey: !!(mask & 4), shiftKey: !!(mask & 8) };
      assert.equal(K.matchAccel(accel, ev), mask === expectedMask);
      assert.equal(K.matchAccel(accel, { ...ev, key: key.toUpperCase() }), mask === expectedMask);
      assert.equal(K.matchAccel(accel, { ...ev, key: 'q' }), false);
    });
  }
}

for (const focus of ['INPUT', 'TEXTAREA', 'contenteditable', 'BODY']) {
  for (const composing of [false, true]) {
    for (const flag of ['none', 'isComposing', 'keyCode229']) {
      test(`全局动作作用域 ${focus}/composing=${composing}/${flag}`, () => {
        let calls = 0;
        const element = focus === 'contenteditable' ? { tagName: 'DIV', isContentEditable: true } : { tagName: focus };
        const km = K.createKeymap({ table: [{ id: 'edit.undo', accel: 'Cmd+Z', aliases: [], owner: 'web' }],
          ctx: { editable: () => K.isEditableElement(element), compositionActive: () => composing } });
        km.composition.active = composing; // 与真实 compositionstart 同步两个入口的观测状态。
        km.register('edit.undo', () => { calls++; });
        let prevented = 0;
        const event = { key: 'z', metaKey: true, preventDefault: () => { prevented++; } };
        if (flag === 'isComposing') event.isComposing = true;
        if (flag === 'keyCode229') event.keyCode = 229;
        const allowed = focus === 'BODY' && !composing && flag === 'none';
        assert.equal(km.handleKeydown(event), allowed);
        assert.equal(calls, allowed ? 1 : 0);
        assert.equal(prevented, allowed ? 1 : 0);
      });
    }
  }
}

for (const [name, event, watch, path, expected] of [
  ['当前', { path: '/中文😀/a.md', seq: 8 }, 8, '/中文😀/a.md', true],
  ['旧票', { path: '/中文😀/a.md', seq: 7 }, 8, '/中文😀/a.md', false],
  ['未来票', { path: '/中文😀/a.md', seq: 9 }, 8, '/中文😀/a.md', false],
  ['无监视', { path: '/中文😀/a.md', seq: 0 }, 0, '/中文😀/a.md', false],
  ['另文档', { path: '/中文😀/b.md', seq: 8 }, 8, '/中文😀/a.md', false],
  ['票型错误', { path: '/中文😀/a.md', seq: '8' }, 8, '/中文😀/a.md', false],
  ['缺票', { path: '/中文😀/a.md' }, 8, '/中文😀/a.md', false],
  ['缺路径', { seq: 8 }, 8, '/中文😀/a.md', false],
  ['无当前文档', { path: '/中文😀/a.md', seq: 8 }, 8, null, false],
  ['空消息', null, 8, '/中文😀/a.md', false],
  ['不同拼写', { path: '/中文😀/./a.md', seq: 8 }, 8, '/中文😀/a.md', false],
]) {
  test(`外部刷新身份 ${name}`, () => assert.equal(R.acceptEvent(event, watch, path), expected));
}

test('作用域矩阵变异：去掉keydown焦点保护会吞输入框按键，正文负对照仍绿', () => {
  const src = fs.readFileSync(require.resolve('../../src/services/keymap.js'), 'utf8');
  const target = '      if (composition.active) return false;\n      if (ctx.editable()) return false;';
  assert.equal(src.split(target).length - 1, 1, '只移除键盘入口的守卫，不改菜单分发入口');
  const box = { module: { exports: {} } };
  vm.runInNewContext(src.replace(target, '      if (composition.active) return false;'), box);
  function invoke(editable) {
    let calls = 0;
    let prevented = 0;
    const km = box.module.exports.createKeymap({ table: [{ id: 'x', accel: 'Cmd+Z', aliases: [], owner: 'web' }],
      ctx: { editable: () => editable, compositionActive: () => false } });
    km.register('x', () => { calls++; });
    km.handleKeydown({ key: 'z', metaKey: true, preventDefault() { prevented++; } });
    return { calls, prevented };
  }
  assert.throws(() => assert.deepEqual(invoke(true), { calls: 0, prevented: 0 }), { code: 'ERR_ASSERTION' });
  assert.deepEqual(invoke(false), { calls: 1, prevented: 1 });
});
