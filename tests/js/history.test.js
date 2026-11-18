// `design/0069` 的单测：**文档访问历史（后退 / 前进）** 与鼠标侧键识别器。
//
// ⭐ 这个文件守的是三件"错了也静默"的事：
//   ① 栈语义（去重 / 截断前进分支 / 上限淘汰 / 光标与条目同步）；
//   ② 侧键必须**先 `preventDefault()` 再导航**（否则 wry 会兜底调用
//      `window.history.back()/forward()`，把整个 WebView 导航走，`INV-HIST-03`）；
//   ③ 只认 `button` 3/4（⛔ 不能碰中键开链接、拖拽、选区，`INV-HIST-04`）。
//
// ⚠️ 纯逻辑、无 DOM、无计时器（`now` 注入）⇒ 可以直接 `node --test`。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../../src/services/history.js');

// ─────────────────────────────────────────────────────────────────────────
// 栈语义（`createHistory`）
// ─────────────────────────────────────────────────────────────────────────

test('空栈：两个方向都到头，current 为 null', () => {
  const h = H.createHistory();
  assert.strictEqual(h.size(), 0);
  assert.strictEqual(h.current(), null);
  assert.strictEqual(h.neighbor(-1), null);
  assert.strictEqual(h.neighbor(1), null);
  assert.strictEqual(h.canGo(-1), false);
  assert.strictEqual(h.canGo(1), false);
  assert.deepStrictEqual(h.entries(), []);
});

test('A→B→C：后退得到 B，末尾再前进为 null', () => {
  const h = H.createHistory();
  assert.strictEqual(h.noteOpen('A'), 'pushed');
  assert.strictEqual(h.noteOpen('B'), 'pushed');
  assert.strictEqual(h.noteOpen('C'), 'pushed');
  assert.deepStrictEqual(h.current(), { path: 'C' });
  assert.deepStrictEqual(h.neighbor(-1), { path: 'B', index: 1 });
  assert.deepStrictEqual(h.neighbor(1), null, '光标在末尾，没有下一份');
  assert.strictEqual(h.size(), 3);
});

test('连续打开同一路径 ⇒ 只有一条，size 不增', () => {
  const h = H.createHistory();
  h.noteOpen('A');
  h.noteOpen('B');
  assert.strictEqual(h.noteOpen('B'), 'same');
  assert.strictEqual(h.size(), 2);
  assert.deepStrictEqual(h.current(), { path: 'B' });
});

test('历史导航命中 expectIndex ⇒ moved，条目不增删', () => {
  const h = H.createHistory();
  h.noteOpen('A');
  h.noteOpen('B');
  h.noteOpen('C');
  const target = h.neighbor(-1);
  assert.deepStrictEqual(target, { path: 'B', index: 1 });
  assert.strictEqual(h.noteOpen('B', { reason: 'history', expectIndex: target.index }), 'moved');
  assert.strictEqual(h.size(), 3);
  assert.deepStrictEqual(h.current(), { path: 'B' });
  // ⚠️ 光标移到中间之后，两个方向都可用。
  assert.deepStrictEqual(h.neighbor(-1), { path: 'A', index: 0 });
  assert.deepStrictEqual(h.neighbor(1), { path: 'C', index: 2 });
});

test('在历史中间打开新文档 ⇒ 前进分支被截断', () => {
  const h = H.createHistory();
  h.noteOpen('A');
  h.noteOpen('B');
  h.noteOpen('C');
  h.noteOpen('B', { reason: 'history', expectIndex: 1 });
  assert.strictEqual(h.noteOpen('D'), 'pushed');
  assert.deepStrictEqual(h.entries().map(x => x.path), ['A', 'B', 'D']);
  assert.deepStrictEqual(h.current(), { path: 'D' });
  assert.strictEqual(h.neighbor(1), null, 'C 已被截断');
});

test('超过上限 ⇒ 最旧被淘汰，光标仍指向最新', () => {
  const h = H.createHistory({ limit: 3 });
  ['A', 'B', 'C', 'D'].forEach(p => h.noteOpen(p));
  assert.strictEqual(h.size(), 3);
  assert.deepStrictEqual(h.entries().map(x => x.path), ['B', 'C', 'D']);
  assert.deepStrictEqual(h.current(), { path: 'D' });
  assert.deepStrictEqual(h.neighbor(-1), { path: 'C', index: 1 });
  // 退到最早一份之后就没有了。
  h.noteOpen('C', { reason: 'history', expectIndex: 1 });
  h.noteOpen('B', { reason: 'history', expectIndex: 0 });
  assert.strictEqual(h.neighbor(-1), null);
});

test('expectIndex 失效 ⇒ 退化为普通 push，⛔ 不越界不抛错', () => {
  const h = H.createHistory();
  h.noteOpen('A');
  h.noteOpen('B');
  // 索引越界 / 指向别的路径 / 不是整数：三条都按普通打开处理。
  assert.strictEqual(h.noteOpen('C', { reason: 'history', expectIndex: 99 }), 'pushed');
  assert.strictEqual(h.noteOpen('D', { reason: 'history', expectIndex: 0 }), 'pushed');
  assert.strictEqual(h.noteOpen('E', { reason: 'history', expectIndex: 1.5 }), 'pushed');
  assert.deepStrictEqual(h.entries().map(x => x.path), ['A', 'B', 'C', 'D', 'E']);
  assert.deepStrictEqual(h.current(), { path: 'E' });
});

test('非 history 的 reason（含 restore）按普通打开入栈', () => {
  const h = H.createHistory();
  assert.strictEqual(h.noteOpen('A', { reason: 'restore' }), 'pushed');
  assert.strictEqual(h.noteOpen('B'), 'pushed');
  assert.deepStrictEqual(h.neighbor(-1), { path: 'A', index: 0 });
});

test('空路径 / 非字符串一律忽略', () => {
  const h = H.createHistory();
  assert.strictEqual(h.noteOpen(''), 'same');
  assert.strictEqual(h.noteOpen(null), 'same');
  assert.strictEqual(h.noteOpen(undefined), 'same');
  assert.strictEqual(h.noteOpen(42), 'same');
  assert.strictEqual(h.size(), 0);
});

test('replacePath：替换所有匹配项并折叠连续重复', () => {
  const h = H.createHistory();
  h.noteOpen('A');
  h.noteOpen('B');
  h.noteOpen('A');
  h.noteOpen('C');
  // entries = A B A C，光标在 C(3)。
  const changed = h.replacePath('A', 'Z');
  assert.strictEqual(changed, 2);
  assert.deepStrictEqual(h.entries().map(x => x.path), ['Z', 'B', 'Z', 'C']);
  assert.deepStrictEqual(h.current(), { path: 'C' });

  // ⭐ 改名可能让新旧路径相邻：替换后折叠，光标映射到保留下来的那条。
  const g = H.createHistory();
  g.noteOpen('A');
  g.noteOpen('B');
  g.noteOpen('A');          // A B A，光标在 2
  g.noteOpen('A', { reason: 'history', expectIndex: 0 }); // 光标回 0（A）
  assert.strictEqual(g.replacePath('A', 'B'), 2);
  assert.deepStrictEqual(g.entries().map(x => x.path), ['B'], '连续重复被折叠');
  assert.deepStrictEqual(g.current(), { path: 'B' });
});

test('replacePath：没有匹配 / 参数无效 ⇒ 0，不动栈', () => {
  const h = H.createHistory();
  h.noteOpen('A');
  assert.strictEqual(h.replacePath('X', 'Y'), 0);
  assert.strictEqual(h.replacePath(null, 'Y'), 0);
  assert.deepStrictEqual(h.entries().map(x => x.path), ['A']);
});

test('entries() 是副本，⛔ 外部改不动栈', () => {
  const h = H.createHistory();
  h.noteOpen('A');
  const copy = h.entries();
  copy.push({ path: 'B' });
  copy[0].path = 'X';
  assert.deepStrictEqual(h.entries().map(x => x.path), ['A']);
});

// ─────────────────────────────────────────────────────────────────────────
// 侧键识别器（`installGestures`）
// ─────────────────────────────────────────────────────────────────────────

function makeWin() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = listeners.findIndex(l => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire(type, ev) { listeners.filter(l => l.type === type).forEach(l => l.fn(ev)); },
    count(type) { return listeners.filter(l => l.type === type).length; },
  };
}

function makeEvent(button) {
  return {
    button,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

test('侧键 mouseup：button 3 后退、4 前进，且 defaultPrevented（承重断言）', () => {
  const win = makeWin();
  const seen = [];
  H.installGestures(win, { onNavigate: d => seen.push(d) });
  const e3 = makeEvent(3);
  win.fire('mouseup', e3);
  assert.deepStrictEqual(seen, [-1]);
  assert.strictEqual(e3.defaultPrevented, true, '必须挡住 wry 的 history.back() 兜底');
  assert.strictEqual(e3.stopped, true);
  const e4 = makeEvent(4);
  win.fire('mouseup', e4);
  assert.deepStrictEqual(seen, [-1, 1]);
  assert.strictEqual(e4.defaultPrevented, true);
});

test('侧键 mousedown：只挡不导航', () => {
  const win = makeWin();
  const seen = [];
  H.installGestures(win, { onNavigate: d => seen.push(d) });
  const e = makeEvent(3);
  win.fire('mousedown', e);
  assert.strictEqual(e.defaultPrevented, true);
  assert.strictEqual(e.stopped, true);
  assert.deepStrictEqual(seen, [], 'mousedown 不导航（避免拖走再松开时留下半截状态）');
});

test('左键 / 中键 / 右键完全不动（⛔ 不 preventDefault，⛔ 不导航）', () => {
  const win = makeWin();
  const seen = [];
  H.installGestures(win, { onNavigate: d => seen.push(d) });
  [0, 1, 2].forEach(button => {
    ['mousedown', 'mouseup', 'auxclick'].forEach(type => {
      const e = makeEvent(button);
      win.fire(type, e);
      assert.strictEqual(e.defaultPrevented, false, type + ' button=' + button + ' 被误挡');
      assert.strictEqual(e.stopped, false);
    });
  });
  assert.deepStrictEqual(seen, []);
});

test('auxclick 防御分支：紧跟同键 mouseup 的 100 ms 内只算一次', () => {
  const win = makeWin();
  let clock = 1000;
  const seen = [];
  H.installGestures(win, { onNavigate: d => seen.push(d), now: () => clock });

  const up = makeEvent(4);
  win.fire('mouseup', up);
  assert.deepStrictEqual(seen, [1]);

  clock += 50;
  const aux = makeEvent(4);
  win.fire('auxclick', aux);
  assert.deepStrictEqual(seen, [1], '50 ms 内同键 auxclick 必须被去重');
  assert.strictEqual(aux.defaultPrevented, true, '去重也要挡，⛔ 不交给 wry');

  clock += 200;
  const late = makeEvent(4);
  win.fire('auxclick', late);
  assert.deepStrictEqual(seen, [1, 1], '超过 100 ms 各算一次');
});

test('幂等：重复 install 不叠监听，uninstall 后不再触发', () => {
  const win = makeWin();
  const seen = [];
  const a = H.installGestures(win, { onNavigate: d => seen.push(d) });
  const b = H.installGestures(win, { onNavigate: d => seen.push(99) });
  assert.strictEqual(a, b, '重复调用返回同一份句柄');
  assert.strictEqual(win.count('mouseup'), 1);
  assert.strictEqual(win.count('mousedown'), 1);
  assert.strictEqual(win.count('auxclick'), 1);

  win.fire('mouseup', makeEvent(3));
  assert.deepStrictEqual(seen, [-1]);

  a.uninstall();
  assert.strictEqual(win.count('mouseup'), 0);
  win.fire('mouseup', makeEvent(3));
  assert.deepStrictEqual(seen, [-1], 'uninstall 之后事件不再触发');
});

test('onNavigate 抛错不影响识别器本身（后续事件照常）', () => {
  const win = makeWin();
  let calls = 0;
  H.installGestures(win, {
    onNavigate: () => { calls++; throw new Error('boom'); },
  });
  // ⚠️ `console.error` 在测试输出里会出现，这是**预期的**（识别器就地记录）。
  win.fire('mouseup', makeEvent(3));
  win.fire('mouseup', makeEvent(4));
  assert.strictEqual(calls, 2);
});

test('没有可用的 win ⇒ 返回空操作句柄（⛔ 不抛错）', () => {
  const h = H.installGestures(null, { onNavigate: () => {} });
  assert.strictEqual(typeof h.uninstall, 'function');
  h.uninstall();
});

// ─────────────────────────────────────────────────────────────────────────
// 接线（源码级）：这几处一旦漏掉，功能"静默失效"而不报错
// ─────────────────────────────────────────────────────────────────────────

test('main.js 的接线点与索引页脚本位次都在', () => {
  const root = path.join(__dirname, '..', '..');
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');

  // ① 提交点之后入栈（`INV-HIST-01`）。⚠️ 两条一起才承重：
  //    ⓐ 提交点之后**有** `noteOpen(real_path)`；
  //    ⓑ 提交点之前**一次都没有**——否则"提前入栈"那种改法（失败也进历史）能溜过去
  //    （变异 M2 实测过：只查 ⓐ 时判据仍绿）。
  assert.ok(/if \(!out\.payload\) return null;[\s\S]{0,400}H\.noteOpen\(out\.payload\.real_path/.test(main),
    'openDocument 的提交点之后必须调用 noteOpen(real_path)');
  const iFn = main.indexOf('async function openDocument(path, opts) {');
  const iCommit = main.indexOf('if (!out.payload) return null;');
  assert.ok(iFn >= 0 && iCommit > iFn, '找不到 openDocument 或它的提交点');
  assert.strictEqual(main.slice(iFn, iCommit).includes('H.noteOpen('), false,
    '提交点之前不许入栈（失败 / 被顶掉 / 取消时栈必须不动）');

  // ② 分栏脏内容重入必须保留 opts（`design/0069` §2.1.2 点名的既有缺陷）。
  //    ⭐ `design/0082`：脏闸抽成 `gateSwitchDoc` 之后，"保留 opts"拆成两半：
  //    ① 调用方把 opts 关进闭包并**重入自己**；② 闸里延迟的是 `proceed`，不是空调用。
  assert.ok(main.includes('if (!(await gateSwitchDoc(baseName(path), function () { return openDocument(path, opts); }))) {'),
    'openDocument 没有把 opts 带过 gateSwitchDoc ⇒ 历史导航会被当成新打开');
  const iGate = main.indexOf('async function gateSwitchDoc(name, proceed) {');
  assert.ok(iGate >= 0, '找不到 gateSwitchDoc');
  const iGateEnd = main.indexOf('async function openDocument(path, opts) {', iGate);
  const gate = main.slice(iGate, iGateEnd > iGate ? iGateEnd : iGate + 4000);
  assert.ok(gate.includes('exitEdit().then(proceed);'),
    '分栏脏内容那一次重入丢了 opts ⇒ 历史导航会被当成新打开');
  assert.strictEqual(/promptLeaveEdit\('edit\.ask-switch'[\s\S]{0,400}?\bproceed\(\);/.test(gate), false,
    '⛔ 闸里不许直接调 proceed()：脏标记要等 exitEdit() 之后才清得掉（会连问两遍）');

  // ③ 两条表项与两个 handler 同批存在（`checkActions` 的判据）。
  assert.ok(main.includes("keymap.register('view.history-back'"), '缺 view.history-back 的 handler');
  assert.ok(main.includes("keymap.register('view.history-forward'"), '缺 view.history-forward 的 handler');

  // ④ 侧键识别器已安装（⚠️ 模块 api 上是 `HMod`，栈实例 `H` 上没有它）。
  assert.ok(/HMod\.installGestures\(window,/.test(main), '侧键识别器未安装');

  // ④b ⭐ **实例必须真的被建出来**（2026-11-13 的线上事故：`H` 直接指向模块 api，
  //     `H.noteOpen` 是 `undefined` ⇒ 每次打开文档都抛 TypeError，正文挂不上、
  //     启动页不走，点收藏还会弹出「可能已被移动、删除或改成了软链」的**误导**提示）。
  //     ⚠️ 判据是"实例化一次 ＋ 实例方法只出现在实例上"，⛔ 不是只查调用点存在。
  assert.ok(/const H = HMod\.createHistory\(\{ limit: 50 \}\)/.test(main),
    'main.js 没有建文档历史实例（⛔ 实例方法直接调在模块 api 上必然 TypeError）');
  assert.strictEqual(/HMod\.(noteOpen|neighbor|replacePath)\(/.test(main), false,
    'noteOpen/neighbor/replacePath 在栈实例上，⛔ 不在模块 api（HMod）上');

  // ⑤ `services/history.js` 必须在 `main.js` 之前加载（加载期取值）。
  const iHistory = html.indexOf('services/history.js');
  const iMain = html.indexOf('src="main.js"');
  assert.ok(iHistory >= 0, 'index.html 少了 services/history.js');
  assert.ok(iMain > iHistory, 'services/history.js 必须排在 main.js 之前');
});
