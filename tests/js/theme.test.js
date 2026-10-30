// `design/0004` §2.1.4.1 与 `design/0005` §2.1.5 的 JS 单测：**主题与阅读设置的服务**。
//
// ⭐ 为什么这些必须测：`0004`/`0005` 落地后的三类缺陷**都不会报错**，
//    只会在某个具体操作序列下漏出来，靠"打开看看"是撞不到的：
//
//   ① `INV-THEME-05`（写盘写的是**当刻全量**）：两个并发写各带一份旧快照、
//      后者覆盖前者。单看每次操作都对，表现是"我改了字号，切一下主题它又回去了"。
//   ② `INV-THEME-01`（只改 CSS 变量）：`data-theme` 上若写下 `system`，
//      CSS 里没有那个选择器 ⇒ 界面塌回浏览器默认色，**不报错**。
//   ③ 尺度钳制：`0`（铺满）被当成"宽度 0"钳掉、或越界值不被夹。
//      ⚠️ 前端夹住、后端夹不住 = 手改配置文件能造出一个两边不一致的状态，
//      所以这些边界值**必须与 Rust 侧 `config::clamp_*` 逐条一致**。
//
// 跑法：`make test-js`（= `node --test tests/js/`）。
// ⚠️ 放在仓库根的 `tests/js/` 而不是 `src/`：`src/` 是 Tauri 的 `frontendDist`，
//    整个目录**会在编译期嵌进二进制**——测试文件不该进产物。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../../src/services/theme.js');

/**
 * 装一个**最小**的 DOM 桩。
 *
 * ⚠️ 只实现被测代码真正碰到的那几个口子（`documentElement.dataset` /
 *    `style.setProperty` / `matchMedia`）——⛔ 不引 jsdom：
 *    这个仓库要能在**没有 node_modules** 的裸机上跑 `make test-js`。
 */
function stubDOM(opts) {
  const o = opts || {};
  const vars = Object.create(null);
  const root = {
    dataset: {},
    style: {
      setProperty: function (k, v) { vars[k] = v; },
      getPropertyValue: function (k) { return vars[k] || ''; },
    },
  };
  global.document = { documentElement: root };
  global.window = {
    matchMedia: function (q) {
      return {
        matches: String(q).indexOf('dark') >= 0 ? !!o.systemDark : false,
        addEventListener: function (type, fn) { if (type === 'change') o.onMQ = fn; },
      };
    },
  };
  return { root: root, vars: vars };
}

/** 等一个条件成立（异步写盘是 setTimeout 驱动的，没法同步断言）。 */
async function until(fn, ms) {
  const limit = Date.now() + (ms || 300);
  while (Date.now() < limit) {
    if (fn()) return true;
    await new Promise(function (r) { setTimeout(r, 5); });
  }
  return !!fn();
}

// ── ① 尺度派生：值写在**根元素的同名变量**上，⛔ 不改 CSS 文件 ──

test('尺度派生_字号直接写进根元素上的同名变量', () => {
  const dom = stubDOM();
  const svc = T.createThemeService({ save: async function () {} });
  svc.reset({ mode: 'light', font_size: 20, line_height: 1.8, content_width: 900 });
  assert.strictEqual(dom.vars['--reader-font-size'], '20px');
  assert.strictEqual(dom.vars['--reader-line-height'], '1.8');
  assert.strictEqual(dom.vars['--reader-content-width'], '900px');
});

test('尺度派生_内容宽度为零时写none而不是0px', () => {
  // ⚠️ 写 `0px` 会让正文宽度**塌成 0**——页面上只剩一条竖线，
  //    而这不是任何一条不变量能拦住的（它是个合法的 CSS 值）。
  const dom = stubDOM();
  const svc = T.createThemeService({ save: async function () {} });
  svc.setContentWidth(0);
  assert.strictEqual(dom.vars['--reader-content-width'], 'none');
});

// ── ② 边界钳制（必须与 Rust 侧 `config::clamp_*` 一致）──

test('钳制_字号两端越界被夹回来', () => {
  const dom = stubDOM();
  const svc = T.createThemeService({ save: async function () {} });
  assert.strictEqual(svc.setFontSize(8), T.FONT_SIZE_MIN, '8 → 12');
  assert.strictEqual(svc.applied.fontSize, 12);
  assert.strictEqual(svc.setFontSize(40), T.FONT_SIZE_MAX, '40 → 28');
  assert.strictEqual(svc.applied.fontSize, 28);
  assert.strictEqual(dom.vars['--reader-font-size'], '28px');
});

test('钳制_行高两端越界被夹回来', () => {
  const svc = T.createThemeService({ save: async function () {} });
  assert.strictEqual(svc.setLineHeight(1.2), 1.2, '下界本身合法');
  assert.strictEqual(svc.setLineHeight(0.5), T.LINE_HEIGHT_MIN);
  assert.strictEqual(svc.setLineHeight(9), T.LINE_HEIGHT_MAX);
});

test('钳制_内容宽度的零是铺满_不是被夹成最小值', () => {
  // ⭐ 这条与 Rust 侧 `clamp_content_width` 是同一个断言的两份实现。
  //    ⛔ 只改一边，手改配置文件就能造出"前端夹得住、后端夹不住"的错。
  assert.strictEqual(T.clampWidth(0), 0, '0（铺满）必须原样留下');
  assert.strictEqual(T.clampWidth(100), T.CONTENT_WIDTH_MIN, '过窄 → 480');
  assert.strictEqual(T.clampWidth(99999), T.CONTENT_WIDTH_MAX, '过宽 → 2400');
  assert.strictEqual(T.clampWidth('abc'), T.DEFAULTS.contentWidth, '非数字 → 默认');
});

test('钳制_非数字回落到默认值而不是变成NaN', () => {
  assert.strictEqual(T.clamp(NaN, 12, 28, 16), 16);
  assert.strictEqual(T.clamp(undefined, 12, 28, 16), 16);
  assert.strictEqual(T.clamp(Infinity, 12, 28, 16), 16);
});

// ── ③ 主题解析：`data-theme` 上永远不出现 `system` ──

test('主题解析_未知名字回落成light而不是原样透传', () => {
  // ⚠️ 配置文件是明文，手改打错一个字不该让阅读器打不开。
  stubDOM();
  assert.strictEqual(T.resolve('nope'), 'light');
  assert.strictEqual(T.resolve('system'), 'light');
  assert.strictEqual(T.resolve(''), 'light');
});

test('主题解析_三个具体主题原样通过', () => {
  stubDOM();
  assert.strictEqual(T.resolve('light'), 'light');
  assert.strictEqual(T.resolve('dark'), 'dark');
  assert.strictEqual(T.resolve('warm'), 'warm');
});

test('主题解析_system按系统偏好解析成具体主题', () => {
  stubDOM({ systemDark: true });
  assert.strictEqual(T.resolve('system'), 'dark');
  stubDOM({ systemDark: false });
  assert.strictEqual(T.resolve('system'), 'light');
});

test('生效的data_theme上绝不写system', () => {
  // ⛔ 写了就等于"没有主题"：CSS 里没有 `[data-theme="system"]`，
  //    界面会**静默**塌回浏览器默认色（一个看起来像"主题没生效"的缺陷）。
  const dom = stubDOM({ systemDark: true });
  const svc = T.createThemeService({ save: async function () {} });
  svc.reset({ mode: 'system' });
  assert.strictEqual(dom.root.dataset.theme, 'dark');
  svc.setMode('warm');
  assert.strictEqual(dom.root.dataset.theme, 'warm');
});

test('跟随系统_只在system模式下响应系统切换', () => {
  // ⭐ B3：**用户的手动选择优先于系统偏好**。
  //    ⚠️ 违反的表现：用户明明选了深色，系统天一黑/一亮就被改回去——
  //    而且只在"system 之后又手动选过"这条罕见路径上出现。
  const opts = { systemDark: false };
  const dom = stubDOM(opts);
  const svc = T.createThemeService({ save: async function () {} });
  svc.attachSystemListener();
  assert.strictEqual(typeof opts.onMQ, 'function', '要真的挂上监听器，否则这条测试什么都没验');

  svc.reset({ mode: 'dark' });          // 用户**显式**选了深色
  assert.strictEqual(dom.root.dataset.theme, 'dark');
  opts.systemDark = true;               // 系统也变成深色
  opts.onMQ();
  assert.strictEqual(dom.root.dataset.theme, 'dark');
  opts.systemDark = false;              // 系统转浅色 —— ⛔ 不许动用户的选择
  opts.onMQ();
  assert.strictEqual(dom.root.dataset.theme, 'dark', '⛔ 系统偏好不许覆盖手动选择');

  svc.setMode('system');                // 用户改主意，选了「跟随系统」
  opts.systemDark = true;
  opts.onMQ();
  assert.strictEqual(dom.root.dataset.theme, 'dark', 'system 下要跟着系统走');
  opts.systemDark = false;
  opts.onMQ();
  assert.strictEqual(dom.root.dataset.theme, 'light');
});

// ── ④ ⭐ `INV-THEME-05`：写盘写的是**当刻全量** ──

test('写盘_一次写就是五个字段全量（⚠️ 线上形状是 snake_case）', async () => {
  stubDOM();
  const writes = [];
  const svc = T.createThemeService({
    save: async function (s) { writes.push(s); },
    debounceMs: 0,
  });
  svc.setMode('dark');
  svc.setFontSize(20);
  await svc._flushNow();
  assert.strictEqual(writes.length, 1, '150ms 窗口里的两次改动应合并成一次写');
  // ⚠️⚠️ **这一条钉的是键名，⛔ 不是"值对不对"**（`docs/bugs/0007`）：
  //    后端 `config::Appearance` 是 snake_case，而 serde 对**不认识的字段是默认忽略**
  //    （⛔ 不报错）⇒ 键名写错的表现是"界面当场生效、关掉再开才发现没存住"。
  //    2026-10-16 实测过一次：那一整轮"外观四件套"里**只有 `mode` 真的落过盘**。
  assert.deepStrictEqual(writes[0],
    { mode: 'dark', font_size: 20, line_height: 1.6, content_width: 1200, vim_mode: false },
    '⛔ 缺字段 = 那次写会把别的设置清回默认；⛔ 键名写成 camelCase = 后端一个字都读不到');
});

test('写盘_写的是当刻全量而不是排队那一刻的快照', async () => {
  // ⭐ 这是 `INV-THEME-05` 的正题：**第一次写还在路上时又改了**，
  //    第二次写必须带上**最新的全部**四个值。
  //    ⚠️ 违反的表现：改成"最后一次改的那个"是对的，但**同时**别的值被回滚。
  stubDOM();
  const writes = [];
  let release = null;
  const gate = new Promise(function (r) { release = r; });
  const svc = T.createThemeService({
    save: async function (s) { writes.push(Object.assign({}, s)); if (writes.length === 1) await gate; },
    debounceMs: 0,
  });

  svc.setFontSize(20);
  const first = svc._flushNow();   // 这次写会挂住
  svc.setMode('dark');             // 写的过程中又改了 —— 走的是 scheduleSave
  release();
  await first;

  assert.ok(await until(function () { return writes.length >= 2; }),
    '在途写完之后，攒下的那次改必须再写一次（⛔ 不能被吞掉）');
  assert.strictEqual(writes[writes.length - 1].mode, 'dark');
  assert.strictEqual(writes[writes.length - 1].font_size, 20,
    '⭐ 第二次写必须带上第一次的改动，⛔ 不是一份只剩 mode 的快照');
});

test('写盘_reset灌入权威值不触发保存', async () => {
  stubDOM();
  const writes = [];
  const svc = T.createThemeService({
    save: async function (s) { writes.push(s); }, debounceMs: 0,
  });
  svc.reset({ mode: 'dark', font_size: 18, line_height: 1.7, content_width: 800 });
  await new Promise(function (r) { setTimeout(r, 30); });
  assert.strictEqual(writes.length, 0, '⛔ 灌默认值不是"用户改了设置"，不该写盘');
});

// ── ⑤ 写失败：置 dirty + 通知，⛔ 不抛、⛔ 不弹错 ──

test('写失败_置dirty并通知界面_不抛异常', async () => {
  stubDOM();
  let notified = 0;
  const svc = T.createThemeService({
    save: async function () { throw new Error('磁盘满了'); },
    debounceMs: 0,
  });
  // ⚠️ `design/0010` §3 的**接口变更**：构造参数里的 `onChange` 换成 `subscribe(fn)`。
  //    ⭐ 换的理由是"订阅者从 1 个变成 2 个"（顶栏 与 设置覆盖层都要跟着画），
  //    而单回调那种写法第二个订阅者会把第一个**顶掉**。
  svc.subscribe(function () { notified++; });
  assert.strictEqual(svc.isDirty(), false);
  svc.setMode('warm');
  await svc._flushNow();           // ⛔ 不许抛——写不进去不值得打断阅读
  assert.strictEqual(svc.isDirty(), true, '失败必须留下痕迹（INV-THEME-06）');
  assert.ok(notified > 0, '要通知界面，它才画得出"未能保存"那行');
  assert.strictEqual(svc.applied.mode, 'warm', '⚠️ 写失败**不影响本次生效**');
  assert.strictEqual(svc.persistedSnapshot(), null, '磁盘上什么都没成功写进去');
});

test('subscribe_多个订阅者都收到_且能退订', async () => {
  // ⭐ `design/0010` §2.1 ④：顶栏与设置覆盖层是**两个**订阅者，
  //    覆盖层关掉/销毁时要能退订（⛔ 不然复开一次就多一个订阅者）。
  stubDOM();
  const hits = [];
  const svc = T.createThemeService({ save: async function () {}, debounceMs: 0 });
  const un1 = svc.subscribe(function () { hits.push('a'); });
  svc.subscribe(function () { hits.push('b'); });
  svc.setFontSize(17);
  assert.deepStrictEqual(hits, ['a', 'b'], '⭐ 两个订阅者**都要**收到，⛔ 不是后者顶掉前者');
  un1();
  svc.setFontSize(18);
  assert.deepStrictEqual(hits, ['a', 'b', 'b'], '退订之后那个不再收到');
  // ⚠️ 没有返回值/传错类型时退订函数必须存在且可调用（⛔ 不抛）。
  assert.strictEqual(typeof svc.subscribe(null), 'function');
});

test('subscribe_一个订阅者抛错_不挡住其余订阅者', async () => {
  // ⚠️ 覆盖层里的 `render()` 抛一次不该让**顶栏也不更新**——
  //    那是"一个坏观察者把整条通知链掐断"，而它的表现是"改了字号，顶栏那个数字不动"。
  stubDOM();
  const hits = [];
  const orig = console.error;
  console.error = function () {};
  try {
    const svc = T.createThemeService({ save: async function () {}, debounceMs: 0 });
    svc.subscribe(function () { hits.push('a'); });
    svc.subscribe(function () { throw new Error('render 崩了'); });
    svc.subscribe(function () { hits.push('c'); });
    svc.setLineHeight(1.8);
  } finally {
    console.error = orig;
  }
  assert.deepStrictEqual(hits, ['a', 'c'], '⭐ 中间的订阅者抛错，前后的都要照常收到');
});

test('写成功_清掉dirty并记下磁盘快照', async () => {
  stubDOM();
  const svc = T.createThemeService({ save: async function () {}, debounceMs: 0 });
  svc.setLineHeight(1.9);
  await svc._flushNow();
  assert.strictEqual(svc.isDirty(), false);
  assert.strictEqual(svc.persistedSnapshot().lineHeight, 1.9);
});

test('失败之后再次成功_dirty被清掉', async () => {
  stubDOM();
  let fail = true;
  const svc = T.createThemeService({
    save: async function () { if (fail) throw new Error('第一次失败'); },
    debounceMs: 0,
  });
  svc.setFontSize(22);
  await svc._flushNow();
  assert.strictEqual(svc.isDirty(), true);
  fail = false;
  await svc._flushNow();
  assert.strictEqual(svc.isDirty(), false, '⭐ 修好之后那行提示必须消失，⛔ 不许一直挂着');
});

// ── ⑥ 默认值：与 `design/0005` 的 A1 / A4 及 `0004` §2.1.2 逐条对齐 ──

test('默认值_与设计的结论一致', () => {
  assert.strictEqual(T.DEFAULTS.fontSize, 14, '0005 §2.1.1 的锚点（⚠️ 2026-10-16 由 16 改 14）');
  assert.strictEqual(T.DEFAULTS.lineHeight, 1.6, 'A1');
  assert.strictEqual(T.DEFAULTS.contentWidth, 1200, 'A4 的宽松上限');
  assert.deepStrictEqual(T.MODES, ['system', 'light', 'dark', 'warm'], 'B2 + B3');
});

test('出厂档_是跟随系统而不是写死的浅色', () => {
  // ⭐ B3：「应用层实现，但**默认提供"跟随系统"这一档**」。
  //    ⚠️ 判据是不做选择的那个用户：深色 Mac 上开箱即白屏，
  //    正是这一条要避免的；而它与 Rust 侧 `default_theme()` 必须一致。
  stubDOM();
  const svc = T.createThemeService({ save: async function () {} });
  assert.strictEqual(svc.applied.mode, 'system', '服务的初值');
  svc.reset({});                       // 配置里没写过外观
  assert.strictEqual(svc.applied.mode, 'system', '快照缺 mode 时的回落目标');
  svc.reset({ mode: 'drak' });         // 手改配置打错一个字
  assert.strictEqual(svc.applied.mode, 'system', '⛔ 不该顺手改成写死的 light');
});

// ── ⑦ ⭐ `design/0014` 裁定 (a)：Vim 模式的开关与优先级 ──

test('Vim：出厂档是**关闭**，而且只在显式 `true` 时才开', () => {
  // ⚠️ 判据是"打开一份文档、什么都没点"的那个用户：
  //    Vim 一旦自己开着，`Esc`/`hjkl` 就从"输入字符"变成"移动光标"，
  //    而**不知道要按 `i` 的人第一反应是键盘坏了**（`0014` §9.1 裁定 (a) 的原话）。
  assert.strictEqual(T.DEFAULT_VIM_MODE, false, '出厂档必须是 false');
  stubDOM();
  const svc = T.createThemeService({ save: async function () {} });
  assert.strictEqual(svc.applied.vimMode, false, '服务的初值');

  svc.reset({});
  assert.strictEqual(svc.applied.vimMode, false, '快照缺 `vim_mode` 时回落成关闭');

  // ⭐ 这一条是**真踩过的那类错**：`!!src.vim_mode` 会把下面三种都读成"开"。
  svc.reset({ vim_mode: 'true' });
  assert.strictEqual(svc.applied.vimMode, false, '⛔ 字符串 "true" 不是 true');
  svc.reset({ vim_mode: 1 });
  assert.strictEqual(svc.applied.vimMode, false, '⛔ 数字 1 不是 true');
  svc.reset({ vim_mode: {} });
  assert.strictEqual(svc.applied.vimMode, false, '⛔ 真值对象不是 true');

  svc.reset({ vim_mode: true });
  assert.strictEqual(svc.applied.vimMode, true, '显式 true 才开');
});

test('Vim：`setVimMode` 是唯一写入口，值没变就什么都不做', async () => {
  stubDOM();
  const writes = [];
  const svc = T.createThemeService({
    save: async function (s) { writes.push(s); }, debounceMs: 0,
  });
  assert.strictEqual(svc.setVimMode(true), true, '第一次是真的改了');
  assert.strictEqual(svc.setVimMode(true), false, '⛔ 再设同一个值什么都不做（否则白写一次盘）');
  // ⚠️ 判据是**严格** `=== true`（与 `reset` 那条同源）：`'yes'` 一律当"关"，
  //    而此刻 applied 正是 `true` ⇒ 这是一次**真的**改动（⛔ 别指望它返回 false）。
  assert.strictEqual(svc.setVimMode('yes'), true, '⛔ 非 `true` 一律当关 ⇒ 从开着变成关着，是真变化');
  assert.strictEqual(svc.applied.vimMode, false, '⛔ 字符串 "yes" 不许被读成开');
  assert.strictEqual(svc.setVimMode(false), false, '关着再设关 ⇒ 什么都没发生');
  assert.strictEqual(svc.setVimMode(0), false, '⛔ 数字 0 同理');
  await svc._flushNow();
  assert.strictEqual(writes.length, 1, '⭐ 三次调用里只有一次真变化 ⇒ 只写一次盘');
  assert.strictEqual(writes[0].vim_mode, false);
});

test('Vim：切主题**不许**顺手把它关掉（同一份记录，同一次写）', async () => {
  // ⚠️ 违反的形态是"切一次主题，Vim 就自己关了"——而**每次单独看都没问题**：
  //    主题那次写是全量的，只要快照里漏带 `vim_mode`，它就被写成默认的 `false`。
  //    ⭐ 这正是 `INV-THEME-05`（写当刻全量）为什么必须把第 5 个字段也带上。
  stubDOM();
  const writes = [];
  const svc = T.createThemeService({
    save: async function (s) { writes.push(s); }, debounceMs: 0,
  });
  svc.setVimMode(true);
  svc.setMode('dark');
  await svc._flushNow();
  assert.strictEqual(writes.length, 1, '两次改动合并成一次写');
  assert.strictEqual(writes[0].vim_mode, true, '⛔ 切主题那次写把 Vim 关掉了');
  assert.strictEqual(writes[0].font_size, 14, '⚠️ 顺带：别的字段也得在');
  assert.strictEqual(svc.persistedSnapshot().vimMode, true, '落盘快照同样带着它');
});

test('Vim：`toPayload` 的键名是后端那套，⛔ 且只有五个键', () => {
  // ⭐ 钉的是**线上形状**：多一个键后端会静默忽略，少一个键后端静默取默认——
  //    两种都是"界面正常、关掉再开才发现"的形态（`docs/bugs/0007`）。
  const p = T.toPayload({ mode: 'warm', fontSize: 18, lineHeight: 1.7, contentWidth: 900, vimMode: true });
  assert.deepStrictEqual(Object.keys(p).sort(),
    ['content_width', 'font_size', 'line_height', 'mode', 'vim_mode'],
    '⛔ 键名/键数变了 —— 后端认的是这一组');
  assert.strictEqual(p.vim_mode, true);
  // ⚠️ 缺 `vimMode` 的那一份（例如老快照）⇒ 线上必须是 `false`，⛔ 不是 `undefined`
  //    （`undefined` 会被 `JSON.stringify` **整个键删掉** ⇒ 后端看到的是"没写过"）。
  assert.strictEqual(T.toPayload({ mode: 'light' }).vim_mode, false);
});
