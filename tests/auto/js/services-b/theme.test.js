// theme 的自动化用例（`tests/auto/js/services-b/`）。
//
// 覆盖：主题枚举、系统偏好解析、尺度夹取、内存态→线上形状、写盘队列的
// “当刻全量”与合并、失败置 dirty、订阅者隔离、Vim 开关的严格 true。
// ⚠️ `apply()` 里读的是**全局 `document`**（不是注入的 window.document），
//    所以本文件在加载前摆一个最小假 DOM；⛔ 不启动浏览器。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function makeDocument() {
  return {
    documentElement: {
      dataset: {},
      style: {
        props: {},
        setProperty: function (k, v) { this.props[k] = v; },
      },
    },
  };
}

const FAKE_DOC = makeDocument();
globalThis.document = FAKE_DOC;

function loadTheme() {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'theme.js'), 'utf8');
  new Function('window', src)(win);
  return { win: win, T: win.rmd.theme };
}

const { win: WIN, T } = loadTheme();

function resetDom() {
  FAKE_DOC.documentElement.dataset = {};
  FAKE_DOC.documentElement.style.props = {};
}

function settle(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms || 20); });
}

function makeService(opts) {
  return T.createThemeService(Object.assign({ save: async function () {}, debounceMs: 1 }, opts || {}));
}

test.beforeEach(function () {
  WIN.matchMedia = undefined;
  resetDom();
});

test('MODES 是 system/light/dark/warm 四种', () => {
  assert.deepStrictEqual(T.MODES, ['system', 'light', 'dark', 'warm']);
});

test('DEFAULTS 是 14 / 1.6 / 1200', () => {
  assert.deepStrictEqual(T.DEFAULTS, { fontSize: 14, lineHeight: 1.6, contentWidth: 1200 });
});

test('Vim 出厂档是关闭', () => {
  assert.strictEqual(T.DEFAULT_VIM_MODE, false);
});

test('clamp：范围内原样、越界夹回、非法值回落', () => {
  assert.strictEqual(T.clamp(15, 12, 28, 14), 15);
  assert.strictEqual(T.clamp(1, 12, 28, 14), 12);
  assert.strictEqual(T.clamp(99, 12, 28, 14), 28);
  assert.strictEqual(T.clamp('20', 12, 28, 14), 14);
  assert.strictEqual(T.clamp(NaN, 12, 28, 14), 14);
  assert.strictEqual(T.clamp(Infinity, 12, 28, 14), 14);
});

test('clampWidth：0 是铺满，不当成“宽度零”夹走', () => {
  assert.strictEqual(T.clampWidth(0), 0);
});

test('clampWidth：低于下限夹到 480，高于上限夹到 2400', () => {
  assert.strictEqual(T.clampWidth(-10), 480);
  assert.strictEqual(T.clampWidth(100), 480);
  assert.strictEqual(T.clampWidth(9999), 2400);
  assert.strictEqual(T.clampWidth(900), 900);
});

test('clampWidth：非法值回落到默认 1200', () => {
  assert.strictEqual(T.clampWidth(NaN), 1200);
  assert.strictEqual(T.clampWidth(Infinity), 1200);
  assert.strictEqual(T.clampWidth('900'), 1200);
});

test('resolve：三个具体主题原样通过', () => {
  assert.strictEqual(T.resolve('light'), 'light');
  assert.strictEqual(T.resolve('dark'), 'dark');
  assert.strictEqual(T.resolve('warm'), 'warm');
});

test('resolve：未知名字回落成 light', () => {
  assert.strictEqual(T.resolve('bogus'), 'light');
  assert.strictEqual(T.resolve(undefined), 'light');
});

test('resolve：system 按系统偏好解析成具体主题', () => {
  WIN.matchMedia = function () { return { matches: true }; };
  assert.strictEqual(T.resolve('system'), 'dark');
  WIN.matchMedia = function () { return { matches: false }; };
  assert.strictEqual(T.resolve('system'), 'light');
});

test('resolve：没有 matchMedia 或它抛错时回落成 light', () => {
  WIN.matchMedia = undefined;
  assert.strictEqual(T.resolve('system'), 'light');
  WIN.matchMedia = function () { throw new Error('no media query'); };
  assert.strictEqual(T.resolve('system'), 'light');
});

test('toPayload：线上形状是五个 snake_case 键，且不多不少', () => {
  const p = T.toPayload({ mode: 'warm', fontSize: 16, lineHeight: 1.5, contentWidth: 0, vimMode: true });
  assert.deepStrictEqual(p, {
    mode: 'warm',
    font_size: 16,
    line_height: 1.5,
    content_width: 0,
    vim_mode: true,
  });
  assert.deepStrictEqual(Object.keys(p).sort(), [
    'content_width', 'font_size', 'line_height', 'mode', 'vim_mode',
  ]);
});

test('toPayload：vim_mode 只在显式 true 时为 true', () => {
  assert.strictEqual(T.toPayload({ vimMode: 'true' }).vim_mode, false);
  assert.strictEqual(T.toPayload({ vimMode: 1 }).vim_mode, false);
  assert.strictEqual(T.toPayload({ vimMode: undefined }).vim_mode, false);
});

test('reset：未知模式回落到出厂档 system', () => {
  const s = makeService();
  s.reset({ mode: 'neon' });
  assert.strictEqual(s.applied.mode, 'system');
});

test('reset：合法模式原样灌入', () => {
  const s = makeService();
  s.reset({ mode: 'warm' });
  assert.strictEqual(s.applied.mode, 'warm');
});

test('reset：字号与行高按后端同口径夹取', () => {
  const s = makeService();
  s.reset({ font_size: 100, line_height: 0.1 });
  assert.strictEqual(s.applied.fontSize, 28);
  assert.strictEqual(s.applied.lineHeight, 1.2);
  s.reset({ font_size: 1, line_height: 9 });
  assert.strictEqual(s.applied.fontSize, 12);
  assert.strictEqual(s.applied.lineHeight, 2);
});

test('reset：内容宽度 0 保留为铺满，非法值回落默认', () => {
  const s = makeService();
  s.reset({ content_width: 0 });
  assert.strictEqual(s.applied.contentWidth, 0);
  s.reset({ content_width: -1 });
  assert.strictEqual(s.applied.contentWidth, 480);
  s.reset({ content_width: 'abc' });
  assert.strictEqual(s.applied.contentWidth, 1200);
});

test('reset：vim_mode 严格 === true，字符串与数字都不算开', () => {
  const s = makeService();
  s.reset({ vim_mode: 'true' });
  assert.strictEqual(s.applied.vimMode, false);
  s.reset({ vim_mode: 1 });
  assert.strictEqual(s.applied.vimMode, false);
  s.reset({ vim_mode: true });
  assert.strictEqual(s.applied.vimMode, true);
});

test('reset：空载荷回到出厂值', () => {
  const s = makeService();
  s.reset();
  assert.deepStrictEqual(s.applied, {
    mode: 'system', fontSize: 14, lineHeight: 1.6, contentWidth: 1200, vimMode: false,
  });
});

test('apply：把解析后的主题与三个尺度写到根元素', () => {
  const s = makeService();
  s.reset({ mode: 'dark', font_size: 18, line_height: 1.8, content_width: 900 });
  const root = FAKE_DOC.documentElement;
  assert.strictEqual(root.dataset.theme, 'dark');
  assert.strictEqual(root.style.props['--reader-font-size'], '18px');
  assert.strictEqual(root.style.props['--reader-line-height'], '1.8');
  assert.strictEqual(root.style.props['--reader-content-width'], '900px');
});

test('apply：内容宽度 0 写成 none 而不是 0px', () => {
  const s = makeService();
  s.reset({ content_width: 0 });
  assert.strictEqual(FAKE_DOC.documentElement.style.props['--reader-content-width'], 'none');
});

test('setMode：非法值或不改变值时什么都不做', async () => {
  const calls = [];
  const s = makeService({ save: async function (p) { calls.push(p); } });
  s.reset({ mode: 'system' });
  s.setMode('bogus');
  s.setMode('system');
  await settle();
  assert.strictEqual(s.applied.mode, 'system');
  assert.strictEqual(FAKE_DOC.documentElement.dataset.theme, 'light');
  assert.strictEqual(calls.length, 0);
});

test('setMode：合法值立即生效并排进写盘队列', async () => {
  const calls = [];
  const s = makeService({ save: async function (p) { calls.push(p); } });
  s.reset({ mode: 'light' });
  s.setMode('dark');
  assert.strictEqual(s.applied.mode, 'dark');
  assert.strictEqual(FAKE_DOC.documentElement.dataset.theme, 'dark');
  await settle();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].mode, 'dark');
});

test('setFontSize：夹取并返回夹取后的值', () => {
  const s = makeService();
  s.reset({ font_size: 14 });
  assert.strictEqual(s.setFontSize(20), 20);
  assert.strictEqual(s.applied.fontSize, 20);
  assert.strictEqual(s.setFontSize(999), 28);
  assert.strictEqual(s.applied.fontSize, 28);
  assert.strictEqual(s.setFontSize(0), 12);
});

test('setLineHeight：夹取并返回夹取后的值', () => {
  const s = makeService();
  s.reset({ line_height: 1.6 });
  assert.strictEqual(s.setLineHeight(1.8), 1.8);
  assert.strictEqual(s.setLineHeight(0.1), 1.2);
  assert.strictEqual(s.applied.lineHeight, 1.2);
});

test('setContentWidth：0 是合法值，负数夹到 480', () => {
  const s = makeService();
  s.reset({ content_width: 900 });
  assert.strictEqual(s.setContentWidth(0), 0);
  assert.strictEqual(s.applied.contentWidth, 0);
  assert.strictEqual(FAKE_DOC.documentElement.style.props['--reader-content-width'], 'none');
  assert.strictEqual(s.setContentWidth(-5), 480);
});

test('setVimMode：只有布尔 true 才开，重复调用返回 false', () => {
  const s = makeService();
  s.reset({ vim_mode: false });
  assert.strictEqual(s.setVimMode('true'), false);
  assert.strictEqual(s.applied.vimMode, false);
  assert.strictEqual(s.setVimMode(1), false);
  assert.strictEqual(s.setVimMode(true), true);
  assert.strictEqual(s.applied.vimMode, true);
  assert.strictEqual(s.setVimMode(true), false);
});

test('subscribe：多个订阅者都收到，退订后只剩另一个', () => {
  const s = makeService();
  const a = [];
  const b = [];
  const offA = s.subscribe(function (api) { a.push(api); });
  s.subscribe(function (api) { b.push(api); });
  s.reset({ mode: 'dark' });
  offA();
  s.reset({ mode: 'light' });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(b.length, 2);
  assert.strictEqual(a[0], s);
});

test('subscribe：一个订阅者抛错不挡住其余订阅者', () => {
  const old = console.error;
  console.error = function () {};
  try {
    const s = makeService();
    let ok = 0;
    s.subscribe(function () { throw new Error('boom'); });
    s.subscribe(function () { ok += 1; });
    s.reset({ mode: 'dark' });
    assert.strictEqual(ok, 1);
  } finally {
    console.error = old;
  }
});

test('写盘：一次 flush 写的是 snake_case 全量，成功后记下磁盘快照', async () => {
  const calls = [];
  const s = makeService({ save: async function (p) { calls.push(p); } });
  s.reset({ mode: 'dark', font_size: 18, line_height: 1.8, content_width: 900, vim_mode: true });
  await s._flushNow();
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], {
    mode: 'dark', font_size: 18, line_height: 1.8, content_width: 900, vim_mode: true,
  });
  assert.deepStrictEqual(s.persistedSnapshot(), {
    mode: 'dark', fontSize: 18, lineHeight: 1.8, contentWidth: 900, vimMode: true,
  });
  assert.strictEqual(s.isDirty(), false);
});

test('写失败：置 dirty、界面不回滚、不抛异常；再次成功才清 dirty', async () => {
  let fail = true;
  const old = console.warn;
  console.warn = function () {};
  try {
    const s = makeService({
      save: async function () { if (fail) throw new Error('disk full'); },
    });
    s.reset({ mode: 'dark', font_size: 20 });
    await s._flushNow();
    assert.strictEqual(s.isDirty(), true);
    assert.strictEqual(s.applied.mode, 'dark');
    assert.strictEqual(s.applied.fontSize, 20);
    fail = false;
    await s._flushNow();
    assert.strictEqual(s.isDirty(), false);
    assert.ok(s.persistedSnapshot());
  } finally {
    console.warn = old;
  }
});

test('写盘合并：防抖窗口内的多次修改只写一次，且写的是当刻全量', async () => {
  const calls = [];
  const s = makeService({ save: async function (p) { calls.push(p); } });
  s.reset({ mode: 'light', font_size: 14, line_height: 1.6, content_width: 1200, vim_mode: false });
  s.setMode('dark');
  s.setFontSize(20);
  s.setContentWidth(0);
  await settle(25);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].mode, 'dark');
  assert.strictEqual(calls[0].font_size, 20);
  assert.strictEqual(calls[0].content_width, 0);
});

test('写盘排队：写的过程中再改，后一次写的是最新全量而不是旧快照', async () => {
  let release;
  const calls = [];
  const s = makeService({
    save: function (p) {
      calls.push(p);
      if (calls.length === 1) return new Promise(function (r) { release = r; });
      return Promise.resolve();
    },
  });
  s.reset({ mode: 'light', font_size: 14 });
  s.setMode('dark');
  const first = s._flushNow();
  s.setFontSize(20);
  const second = s._flushNow();
  release();
  await first;
  await settle(25);
  await second;
  assert.strictEqual(calls[0].font_size, 14, '第一笔应是排队那一刻的旧值');
  assert.strictEqual(calls[calls.length - 1].font_size, 20, '后一笔必须带上最新字号');
  assert.strictEqual(calls[calls.length - 1].mode, 'dark');
});

test('reset 不触发写盘', async () => {
  const calls = [];
  const s = makeService({ save: async function (p) { calls.push(p); } });
  s.reset({ mode: 'dark', font_size: 20 });
  await settle(25);
  assert.strictEqual(calls.length, 0);
});

test('attachSystemListener：只在 system 模式下随系统变化重画', () => {
  const handlers = [];
  WIN.matchMedia = function () {
    return {
      matches: false,
      addEventListener: function (name, fn) { handlers.push(fn); },
    };
  };
  const s = makeService();
  s.reset({ mode: 'system' });
  s.attachSystemListener();
  assert.strictEqual(handlers.length, 1);

  let notified = 0;
  s.subscribe(function () { notified += 1; });
  WIN.matchMedia = function () { return { matches: true }; };
  handlers[0]();
  assert.strictEqual(FAKE_DOC.documentElement.dataset.theme, 'dark');
  assert.ok(notified > 0);

  s.setMode('light');
  notified = 0;
  WIN.matchMedia = function () { return { matches: true }; };
  handlers[0]();
  assert.strictEqual(notified, 0, '用户手动选了浅色后系统切换不许动他的选择');
});

test('attachSystemListener：拿不到 matchMedia 或它没有 addEventListener 时不抛', () => {
  WIN.matchMedia = undefined;
  const s = makeService();
  assert.doesNotThrow(function () { s.attachSystemListener(); });
  WIN.matchMedia = function () { return {}; };
  assert.doesNotThrow(function () { s.attachSystemListener(); });
});
