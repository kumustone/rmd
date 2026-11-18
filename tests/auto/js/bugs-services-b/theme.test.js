// theme 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：`0007` 的 camelCase→snake_case 落盘形状、单写者队列的"写当刻全量"、
// 写失败只置 dirty 不弹错、`0002` 的"外观永不落盘"、以及边界钳制与模式解析。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

const SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'theme.js'), 'utf8');

function loadTheme(win) {
  const w = win || {};
  new Function('window', SRC)(w);
  return w.rmd.theme;
}

function makeDoc() {
  const props = Object.create(null);
  const doc = {
    documentElement: {
      dataset: {},
      style: {
        setProperty: function (k, v) { props[k] = v; },
      },
    },
    querySelectorAll: function () { return []; },
  };
  return { doc: doc, props: props };
}

const T = loadTheme({});

let current;
test.beforeEach(function () {
  current = makeDoc();
  global.document = current.doc;
});

test.after(function () { delete global.document; });

function makeSvc(opts) {
  const o = Object.assign({ save: async function () {}, debounceMs: 0 }, opts || {});
  return T.createThemeService(o);
}

function tick(ms) {
  return new Promise(function (r) { setTimeout(r, ms === undefined ? 8 : ms); });
}

// ── 常量与出厂档 ────────────────────────────────────────────────────

// 源自 docs/bugs/0002（外观设置永不落盘）
test('四种模式与出厂默认值逐字锁死（改动会让已存配置含义漂移）', () => {
  assert.deepStrictEqual(T.MODES, ['system', 'light', 'dark', 'warm']);
  assert.deepStrictEqual(T.DEFAULTS, { fontSize: 14, lineHeight: 1.6, contentWidth: 1200 });
  assert.strictEqual(T.DEFAULT_VIM_MODE, false);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('字号 / 行高 / 内容宽度三组边界与 Rust 侧一致', () => {
  assert.strictEqual(T.FONT_SIZE_MIN, 12);
  assert.strictEqual(T.FONT_SIZE_MAX, 28);
  assert.strictEqual(T.LINE_HEIGHT_MIN, 1.2);
  assert.strictEqual(T.LINE_HEIGHT_MAX, 2.0);
  assert.strictEqual(T.CONTENT_WIDTH_MIN, 480);
  assert.strictEqual(T.CONTENT_WIDTH_MAX, 2400);
});

// ── 0007：线上形状与内存形状的键名 ─────────────────────────────────

// 源自 docs/bugs/0007（外观只存住了主题）
test('toPayload 逐字产出后端认得的五个 snake_case 键', () => {
  const got = T.toPayload({ mode: 'dark', fontSize: 20, lineHeight: 1.8, contentWidth: 900, vimMode: true });
  assert.deepStrictEqual(got, {
    mode: 'dark', font_size: 20, line_height: 1.8, content_width: 900, vim_mode: true,
  });
  assert.deepStrictEqual(Object.keys(got).sort(),
    ['content_width', 'font_size', 'line_height', 'mode', 'vim_mode']);
});

// 源自 docs/bugs/0007（外观只存住了主题）
test('toPayload 绝不含 camelCase 键——serde 会静默忽略它们', () => {
  const got = T.toPayload({ mode: 'warm', fontSize: 16, lineHeight: 1.4, contentWidth: 700, vimMode: false });
  assert.strictEqual('fontSize' in got, false);
  assert.strictEqual('lineHeight' in got, false);
  assert.strictEqual('contentWidth' in got, false);
  assert.strictEqual('vimMode' in got, false);
});

// 源自 docs/bugs/0007（外观只存住了主题）
test('toPayload 的 vim_mode 只认严格 true，字符串 "true" 不算', () => {
  assert.strictEqual(T.toPayload({ vimMode: true }).vim_mode, true);
  assert.strictEqual(T.toPayload({ vimMode: 'true' }).vim_mode, false);
  assert.strictEqual(T.toPayload({ vimMode: 1 }).vim_mode, false);
  assert.strictEqual(T.toPayload({}).vim_mode, false);
});

// 源自 docs/bugs/0007（外观只存住了主题）
test('服务 flush 走的确实是 toPayload：save 收到的就是 snake_case', async () => {
  const seen = [];
  const svc = makeSvc({ save: async function (p) { seen.push(p); } });
  svc.reset({ mode: 'dark', font_size: 22, line_height: 1.7, content_width: 0, vim_mode: true });
  svc.setFontSize(24);
  await svc._flushNow();
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(seen[0], {
    mode: 'dark', font_size: 24, line_height: 1.7, content_width: 0, vim_mode: true,
  });
});

// ── 边界钳制 ────────────────────────────────────────────────────────

// 源自 docs/bugs/0002（外观设置永不落盘）
test('clamp：区间内原样，越界夹到端点', () => {
  assert.strictEqual(T.clamp(14, 12, 28, 14), 14);
  assert.strictEqual(T.clamp(11, 12, 28, 14), 12);
  assert.strictEqual(T.clamp(29, 12, 28, 14), 28);
  assert.strictEqual(T.clamp(12, 12, 28, 14), 12);
  assert.strictEqual(T.clamp(28, 12, 28, 14), 28);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('clamp：非数字 / NaN / ±Infinity 一律回落到 fallback', () => {
  assert.strictEqual(T.clamp(null, 12, 28, 14), 14);
  assert.strictEqual(T.clamp(undefined, 12, 28, 14), 14);
  assert.strictEqual(T.clamp('20', 12, 28, 14), 14);
  assert.strictEqual(T.clamp(NaN, 12, 28, 14), 14);
  assert.strictEqual(T.clamp(Infinity, 12, 28, 14), 14);
  assert.strictEqual(T.clamp(-Infinity, 12, 28, 14), 14);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('clampWidth：0 是「铺满」的合法值，⛔ 不被夹成 480', () => {
  assert.strictEqual(T.clampWidth(0), 0);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('clampWidth：负值夹到 480，超上限夹到 2400，渠道值原样', () => {
  assert.strictEqual(T.clampWidth(-1), 480);
  assert.strictEqual(T.clampWidth(479), 480);
  assert.strictEqual(T.clampWidth(480), 480);
  assert.strictEqual(T.clampWidth(2400), 2400);
  assert.strictEqual(T.clampWidth(2401), 2400);
  assert.strictEqual(T.clampWidth(1000), 1000);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('clampWidth：非数字回落到 1200，NaN / Infinity 也是', () => {
  assert.strictEqual(T.clampWidth(null), 1200);
  assert.strictEqual(T.clampWidth('0'), 1200);
  assert.strictEqual(T.clampWidth(NaN), 1200);
  assert.strictEqual(T.clampWidth(Infinity), 1200);
});

// ── 模式解析 ────────────────────────────────────────────────────────

// 源自 docs/bugs/0002（外观设置永不落盘）
test('resolve：light / dark / warm 原样；未知模式回落到 light', () => {
  const T2 = loadTheme({});
  assert.strictEqual(T2.resolve('light'), 'light');
  assert.strictEqual(T2.resolve('dark'), 'dark');
  assert.strictEqual(T2.resolve('warm'), 'warm');
  assert.strictEqual(T2.resolve('sepia'), 'light');
  assert.strictEqual(T2.resolve(''), 'light');
  assert.strictEqual(T2.resolve(undefined), 'light');
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('resolve：system 跟随 matchMedia，深色偏好给 dark、浅色给 light', () => {
  const dark = loadTheme({ matchMedia: function () { return { matches: true }; } });
  const light = loadTheme({ matchMedia: function () { return { matches: false }; } });
  assert.strictEqual(dark.resolve('system'), 'dark');
  assert.strictEqual(light.resolve('system'), 'light');
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('resolve：matchMedia 抛错时 system 退化成 light，⛔ 不抛', () => {
  const broken = loadTheme({ matchMedia: function () { throw new Error('no mq'); } });
  assert.strictEqual(broken.resolve('system'), 'light');
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('data-theme 永远写解析后的值，⛔ 不写 system（CSS 里没有这个选择器）', () => {
  const svc = makeSvc();
  svc.reset({ mode: 'system' });
  assert.strictEqual(current.doc.documentElement.dataset.theme, 'light');
  assert.notStrictEqual(current.doc.documentElement.dataset.theme, 'system');
});

// ── apply：只改变量与 data 属性 ─────────────────────────────────────

// 源自 docs/bugs/0002（外观设置永不落盘）
test('apply 写三个尺度变量：字号带 px、行高原样、内容宽度带 px', () => {
  const svc = makeSvc();
  svc.reset({ mode: 'dark', font_size: 16, line_height: 1.5, content_width: 900 });
  assert.deepStrictEqual(Object.assign({}, current.props), {
    '--reader-font-size': '16px',
    '--reader-line-height': '1.5',
    '--reader-content-width': '900px',
  });
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('内容宽度 0 写成 none，⛔ 不是 0px（0px 会让正文塌成 0 宽）', () => {
  const svc = makeSvc();
  svc.reset({ content_width: 0 });
  assert.strictEqual(current.props['--reader-content-width'], 'none');
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('reset 不触发保存：冷启动灌值不该把默认值反写回磁盘', async () => {
  let saves = 0;
  const svc = makeSvc({ save: async function () { saves += 1; } });
  svc.reset({ mode: 'dark', font_size: 20, line_height: 1.8, content_width: 1000 });
  await tick();
  assert.strictEqual(saves, 0);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('reset：未知模式回到 system 出厂档，⛔ 不是 light', () => {
  const svc = makeSvc();
  svc.reset({ mode: 'not-a-mode' });
  assert.strictEqual(svc.applied.mode, 'system');
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('reset：字符串数字能转成数值，各自夹到边界', () => {
  const svc = makeSvc();
  svc.reset({ font_size: '99', line_height: '0.5', content_width: '100' });
  assert.strictEqual(svc.applied.fontSize, 28);
  assert.strictEqual(svc.applied.lineHeight, 1.2);
  assert.strictEqual(svc.applied.contentWidth, 480);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('reset：缺失 / 非法尺度回落到出厂值', () => {
  const svc = makeSvc();
  svc.reset({});
  assert.strictEqual(svc.applied.fontSize, 14);
  assert.strictEqual(svc.applied.lineHeight, 1.6);
  assert.strictEqual(svc.applied.contentWidth, 1200);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('reset：vim_mode 只认严格 true，字符串 / 1 / 缺省都算关', () => {
  const svc = makeSvc();
  svc.reset({ vim_mode: true });
  assert.strictEqual(svc.applied.vimMode, true);
  svc.reset({ vim_mode: 'true' });
  assert.strictEqual(svc.applied.vimMode, false);
  svc.reset({ vim_mode: 1 });
  assert.strictEqual(svc.applied.vimMode, false);
  svc.reset({});
  assert.strictEqual(svc.applied.vimMode, false);
});

// ── setter：立即生效 + 合并保存 ─────────────────────────────────────

// 源自 docs/bugs/0002（外观设置永不落盘）
test('setMode：合法模式立即生效并进保存队列', async () => {
  const seen = [];
  const svc = makeSvc({ save: async function (p) { seen.push(p.mode); } });
  svc.reset({ mode: 'light' });
  svc.setMode('dark');
  assert.strictEqual(svc.applied.mode, 'dark');
  assert.strictEqual(current.doc.documentElement.dataset.theme, 'dark');
  await tick();
  assert.deepStrictEqual(seen, ['dark']);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('setMode：未知模式与同值都是空操作，不写盘', async () => {
  let saves = 0;
  const svc = makeSvc({ save: async function () { saves += 1; } });
  svc.reset({ mode: 'light' });
  svc.setMode('nope');
  svc.setMode('light');
  await tick();
  assert.strictEqual(svc.applied.mode, 'light');
  assert.strictEqual(saves, 0);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('setFontSize / setLineHeight：夹取后返回真实写入值，越界时返回端点', () => {
  const svc = makeSvc();
  svc.reset({});
  assert.strictEqual(svc.setFontSize(20), 20);
  assert.strictEqual(svc.setFontSize(100), 28);
  assert.strictEqual(svc.setFontSize(1), 12);
  assert.strictEqual(svc.setLineHeight(1.9), 1.9);
  assert.strictEqual(svc.setLineHeight(3), 2.0);
  assert.strictEqual(svc.setLineHeight(0.1), 1.2);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('setFontSize：非数字不改变现状（沿用当前值做 fallback）', () => {
  const svc = makeSvc();
  svc.reset({ font_size: 18 });
  assert.strictEqual(svc.setFontSize('big'), 18);
  assert.strictEqual(svc.applied.fontSize, 18);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('setContentWidth：0 能设成铺满，且不会被当成"没变"', async () => {
  const seen = [];
  const svc = makeSvc({ save: async function (p) { seen.push(p.content_width); } });
  svc.reset({ content_width: 1200 });
  assert.strictEqual(svc.setContentWidth(0), 0);
  assert.strictEqual(svc.applied.contentWidth, 0);
  await tick();
  assert.deepStrictEqual(seen, [0]);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('setVimMode：严格 true 才开，返回值说明是否真的改了', () => {
  const svc = makeSvc();
  svc.reset({});
  assert.strictEqual(svc.setVimMode(true), true);
  assert.strictEqual(svc.setVimMode(true), false);
  assert.strictEqual(svc.applied.vimMode, true);
  // 非 true 的值一律按"关"处理，而不是被读成开
  assert.strictEqual(svc.setVimMode('true'), true);
  assert.strictEqual(svc.applied.vimMode, false);
  assert.strictEqual(svc.setVimMode(false), false);
  assert.strictEqual(svc.setVimMode(1), false);
});

// ── 订阅 ────────────────────────────────────────────────────────────

// 源自 docs/bugs/0002（外观设置永不落盘）
test('apply 是通知的唯一汇合点：四条 setter、reset、跟随系统都通知', () => {
  const svc = makeSvc();
  const modes = [];
  svc.subscribe(function (api) { modes.push(api.applied.mode); });
  svc.reset({ mode: 'light' });
  svc.setMode('dark');
  svc.setFontSize(20);
  svc.setLineHeight(1.8);
  svc.setContentWidth(800);
  assert.deepStrictEqual(modes, ['light', 'dark', 'dark', 'dark', 'dark']);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('退订后不再收到；非函数订阅返回可调用的空函数', () => {
  const svc = makeSvc();
  const got = [];
  const off = svc.subscribe(function () { got.push(1); });
  svc.reset({ mode: 'dark' });
  off();
  svc.setMode('warm');
  assert.deepStrictEqual(got, [1]);
  assert.doesNotThrow(function () { svc.subscribe(null)(); });
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('一个订阅者抛错不挡住另一个（设置面坏了不能连累顶栏）', () => {
  const old = console.error;
  console.error = function () {};
  try {
    const svc = makeSvc();
    const got = [];
    svc.subscribe(function () { throw new Error('设置面坏了'); });
    svc.subscribe(function (api) { got.push(api.applied.mode); });
    svc.setMode('dark');
    assert.deepStrictEqual(got, ['dark']);
  } finally {
    console.error = old;
  }
});

// ── INV-THEME-05：串行单一写者 ─────────────────────────────────────

// 源自 docs/bugs/0007（外观只存住了主题）
test('连续多次改动被合并成一次写，写的是当刻全量', async () => {
  const seen = [];
  const svc = makeSvc({ save: async function (p) { seen.push(p); } });
  svc.reset({ mode: 'light', font_size: 14, line_height: 1.6, content_width: 1200 });
  svc.setFontSize(16);
  svc.setFontSize(18);
  svc.setMode('dark');
  await tick();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].font_size, 18);
  assert.strictEqual(seen[0].mode, 'dark');
});

// 源自 docs/bugs/0007（外观只存住了主题）
test('写进行中再改一次：写完会再排一次，最终落盘的是最新全量', async () => {
  const seen = [];
  let release;
  const gate = new Promise(function (r) { release = r; });
  let first = true;
  const svc = makeSvc({
    save: async function (p) {
      seen.push(p);
      if (first) { first = false; await gate; }
    },
  });
  svc.reset({ mode: 'light' });
  svc.setFontSize(16);
  const flushPromise = svc._flushNow();
  // 写还没回来时又改了两个值
  svc.setFontSize(20);
  svc.setMode('dark');
  release();
  await flushPromise;
  await tick(20);
  assert.ok(seen.length >= 2, '第二次写没有排上：' + seen.length);
  assert.strictEqual(seen[seen.length - 1].font_size, 20);
  assert.strictEqual(seen[seen.length - 1].mode, 'dark');
});

// 源自 docs/bugs/0007（外观只存住了主题）
test('flush 写的是当刻 applied，不是排程那一刻的快照', async () => {
  const seen = [];
  const svc = makeSvc({ save: async function (p) { seen.push(p); } });
  svc.reset({ mode: 'light', font_size: 14 });
  svc.setFontSize(16);
  // 还没 flush，又改一次
  svc.applied.fontSize = 22;
  await svc._flushNow();
  assert.strictEqual(seen[seen.length - 1].font_size, 22);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('写成功后 persisted 记下快照，dirty 保持 false', async () => {
  const svc = makeSvc();
  svc.reset({ mode: 'dark' });
  assert.strictEqual(svc.persistedSnapshot(), null);
  svc.setFontSize(20);
  await svc._flushNow();
  assert.deepStrictEqual(svc.persistedSnapshot(), {
    mode: 'dark', fontSize: 20, lineHeight: 1.6, contentWidth: 1200, vimMode: false,
  });
  assert.strictEqual(svc.isDirty(), false);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('写失败：dirty 置位、界面值不回退、persisted 不动，⛔ 不抛给调用方', async () => {
  const old = console.warn;
  console.warn = function () {};
  try {
    const svc = makeSvc({ save: async function () { throw new Error('ACL 拒绝'); } });
    svc.reset({ mode: 'light' });
    svc.setMode('dark');
    await assert.doesNotReject(function () { return svc._flushNow(); });
    assert.strictEqual(svc.isDirty(), true);
    assert.strictEqual(svc.applied.mode, 'dark');
    assert.strictEqual(svc.persistedSnapshot(), null);
    assert.strictEqual(current.doc.documentElement.dataset.theme, 'dark');
  } finally {
    console.warn = old;
  }
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('失败之后再成功：dirty 被清掉（用户看到的那行警告要能消失）', async () => {
  const old = console.warn;
  console.warn = function () {};
  try {
    let fail = true;
    const svc = makeSvc({
      save: async function () { if (fail) throw new Error('首次失败'); },
    });
    svc.reset({});
    svc.setMode('dark');
    await svc._flushNow();
    assert.strictEqual(svc.isDirty(), true);
    fail = false;
    svc.setMode('warm');
    await svc._flushNow();
    assert.strictEqual(svc.isDirty(), false);
  } finally {
    console.warn = old;
  }
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('写失败也通知订阅者：工具栏那行警告靠这次通知亮起', async () => {
  const old = console.warn;
  console.warn = function () {};
  try {
    const svc = makeSvc({ save: async function () { throw new Error('失败'); } });
    svc.reset({});
    let notices = 0;
    svc.subscribe(function () { notices += 1; });
    svc.setMode('dark');
    const before = notices;
    await svc._flushNow();
    assert.strictEqual(notices, before + 1);
  } finally {
    console.warn = old;
  }
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('跟随系统的监听只在 mode=system 时重解析，用户选了 dark 就不动', () => {
  let handler = null;
  let dark = false;
  const win = {
    matchMedia: function () {
      return {
        get matches() { return dark; },
        addEventListener: function (name, fn) { handler = fn; },
      };
    },
  };
  const T2 = loadTheme(win);
  const svc = T2.createThemeService({ save: async function () {}, debounceMs: 0 });
  svc.reset({ mode: 'system' });
  svc.attachSystemListener();
  assert.strictEqual(current.doc.documentElement.dataset.theme, 'light');
  dark = true;
  handler();
  assert.strictEqual(current.doc.documentElement.dataset.theme, 'dark');

  svc.setMode('light');
  dark = false;
  handler();
  assert.strictEqual(svc.applied.mode, 'light');
  assert.strictEqual(current.doc.documentElement.dataset.theme, 'light');
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('系统监听不写盘：变的是系统偏好，不是用户的选择', async () => {
  let handler = null;
  let saves = 0;
  const win = {
    matchMedia: function () {
      return { matches: false, addEventListener: function (n, fn) { handler = fn; } };
    },
  };
  const T2 = loadTheme(win);
  const svc = T2.createThemeService({
    save: async function () { saves += 1; }, debounceMs: 0,
  });
  svc.reset({ mode: 'system' });
  svc.attachSystemListener();
  handler();
  await tick();
  assert.strictEqual(saves, 0);
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('attachSystemListener 在没有 matchMedia 时静默退化，⛔ 不抛', () => {
  const svc = makeSvc();
  assert.doesNotThrow(function () { svc.attachSystemListener(); });
});

// 源自 docs/bugs/0002（外观设置永不落盘）
test('apply 不改 DOM 结构：只碰 dataset 与行内样式', () => {
  const svc = makeSvc();
  svc.reset({ mode: 'dark' });
  const root = current.doc.documentElement;
  assert.deepStrictEqual(Object.keys(root.dataset), ['theme']);
  assert.deepStrictEqual(Object.keys(current.props).sort(), [
    '--reader-content-width', '--reader-font-size', '--reader-line-height',
  ]);
});
