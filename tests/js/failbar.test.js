// `design/0070`（操作失败的呈现位置，2026-11-13 已通过）的**判据**。
//
// # 这一格守的是什么
//
// 失败被放错容器**不会报任何错**：
// ① 一条"锚点不存在"顶掉"保存失败"⇒ 用户以为已经保存了（`INV-FAIL-04`）；
// ② 失败跟着上一个文档的页面留着 / 换了文档却莫名消失（作用域派生）；
// ③ 重试连点两次 ⇒ 两次写入 / 两次打开；
// ④ `P1` 也挂 `role=alert` ⇒ 读屏每次都被打断（`INV-FAIL-06`）。
// 这些的屏幕表现都只是"提示条里那句话不对"，没有任何浏览器报错。
//
// ⚠️ 判据对**注释免疫**：源码里大量写着"⛔ 别写成 X"，所以源码级判据先 `strip*`。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FB = require('../../src/services/failbar.js');

const ROOT = path.join(__dirname, '..', '..');
const read = function (p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); };

function stripBlockComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

function stripLineComments(src) {
  return String(src).split('\n').map(function (line) {
    const i = line.indexOf('//');
    if (i < 0) return line;
    const before = line.slice(0, i);
    const quotes = (before.match(/["']/g) || []).length;
    if (quotes % 2 === 1) return line;
    return before;
  }).join('\n');
}

function strip(src) { return stripLineComments(stripBlockComments(src)); }

// ────────────────────────────────────────────────────────────────
// 假 DOM（`createFailBar` 的 DOM 由调用方注入，`node --test` 里不碰浏览器）
// ────────────────────────────────────────────────────────────────

function El(tag) {
  this.tagName = String(tag).toUpperCase();
  this.className = '';
  this.textContent = '';
  this.title = '';
  this.hidden = false;
  this.disabled = false;
  this.dataset = {};
  this.children = [];
  this.firstChild = null;
  this.listeners = {};
  this._attrs = {};
}

El.prototype.appendChild = function (c) {
  this.children.push(c);
  this.firstChild = this.children[0];
  return c;
};

El.prototype.removeChild = function (c) {
  const i = this.children.indexOf(c);
  if (i >= 0) this.children.splice(i, 1);
  this.firstChild = this.children[0] || null;
  return c;
};

El.prototype.addEventListener = function (type, fn) { this.listeners[type] = fn; };
El.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
El.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; };

function fakeDoc(ids) {
  const els = {};
  Object.keys(ids).forEach(function (id) { els[id] = new El('div'); });
  return {
    els: els,
    getElementById: function (id) { return els[id] || null; },
    createElement: function (tag) { return new El(tag); },
  };
}

function fullDoc() {
  const doc = fakeDoc({ 'fail-bar': 1, 'fail-text': 1, 'fail-actions': 1, 'fail-detail': 1 });
  // 与 `index.html` 一致：`#fail-bar` 初始就是 `hidden`。
  doc.els['fail-bar'].hidden = true;
  return doc;
}

/** 假字典：`t(key, vars)` 直接回一段可辨认的串（并带上 vars 里那个 name）。 */
function fakeT(key, vars) {
  return vars && vars.name ? key + ':' + vars.name : key;
}

/** 数动作区里的按钮（`fail-btn` / `fail-close`）。 */
function buttons(doc) {
  return doc.els['fail-actions'].children;
}

function byClass(list, cls) {
  return list.filter(function (b) { return String(b.className).split(/\s+/).indexOf(cls) >= 0; });
}

async function flush() {
  // 两次微任务：一次给 `Promise.resolve(a.run()).then(…)`，一次给里面再套一层。
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ────────────────────────────────────────────────────────────────
// ① 纯逻辑
// ────────────────────────────────────────────────────────────────

test('级别归一：只认 P0 / P1，其它一律 P1（⛔ 不静默升级）', function () {
  assert.strictEqual(FB.pickLevel('P0'), 'P0');
  assert.strictEqual(FB.pickLevel('P1'), 'P1');
  assert.strictEqual(FB.pickLevel('P2'), 'P1');
  assert.strictEqual(FB.pickLevel(undefined), 'P1');
});

test('替换规则：P0 只被 P0 替换，P1 可被两档替换（INV-FAIL-04）', function () {
  assert.strictEqual(FB.canReplace(null, 'P1'), true);
  assert.strictEqual(FB.canReplace(null, 'P0'), true);
  assert.strictEqual(FB.canReplace('P1', 'P0'), true);
  assert.strictEqual(FB.canReplace('P1', 'P1'), true);
  assert.strictEqual(FB.canReplace('P0', 'P0'), true);
  // ⭐ 这条是本设计的核心：保存失败不许被一条轻的提示顶掉。
  assert.strictEqual(FB.canReplace('P0', 'P1'), false);
});

test('作用域：doc 随路径、start 随启动页、none/global 只按关闭', function () {
  const doc = { kind: 'doc', path: '/a.md' };
  assert.strictEqual(FB.scopeAlive(doc, { docPath: '/a.md' }), true);
  assert.strictEqual(FB.scopeAlive(doc, { docPath: '/b.md' }), false);
  assert.strictEqual(FB.scopeAlive(doc, { docPath: null }), false);
  assert.strictEqual(FB.scopeAlive(doc, {}), false);
  assert.strictEqual(FB.scopeAlive({ kind: 'start' }, { startVisible: true }), true);
  assert.strictEqual(FB.scopeAlive({ kind: 'start' }, { startVisible: false }), false);
  assert.strictEqual(FB.scopeAlive({ kind: 'none' }, {}), true);
  assert.strictEqual(FB.scopeAlive({ kind: 'global' }, {}), true);
  assert.strictEqual(FB.scopeAlive(null, {}), true);
});

// ────────────────────────────────────────────────────────────────
// ② 渲染（假 DOM）
// ────────────────────────────────────────────────────────────────

test('显示与关闭：文案、显隐、aria-live 按级别选（P1 = polite）', function () {
  const doc = fullDoc();
  const bar = FB.createFailBar({ doc: doc, t: fakeT });
  assert.strictEqual(bar.available(), true);
  assert.strictEqual(doc.els['fail-bar'].hidden, true);

  assert.strictEqual(bar.raise({ key: 'status.open-failed', level: 'P1' }), true);
  assert.strictEqual(doc.els['fail-bar'].hidden, false);
  assert.strictEqual(doc.els['fail-text'].textContent, 'status.open-failed');
  assert.strictEqual(doc.els['fail-bar'].getAttribute('role'), 'status');
  assert.strictEqual(doc.els['fail-bar'].getAttribute('aria-live'), 'polite');
  assert.strictEqual(doc.els['fail-bar'].getAttribute('data-level'), 'P1');

  bar.close();
  assert.strictEqual(doc.els['fail-bar'].hidden, true);
  assert.strictEqual(doc.els['fail-text'].textContent, '');
  assert.strictEqual(buttons(doc).length, 0);
});

test('P0 用 role=alert 与 assertive（INV-FAIL-06）', function () {
  const doc = fullDoc();
  const bar = FB.createFailBar({ doc: doc, t: fakeT });
  bar.raise({ key: 'status.startup-failed', level: 'P0' });
  assert.strictEqual(doc.els['fail-bar'].getAttribute('role'), 'alert');
  assert.strictEqual(doc.els['fail-bar'].getAttribute('aria-live'), 'assertive');
});

test('P0 在屏时 P1 被挡下：文案不变、onRejected 收到它', function () {
  const doc = fullDoc();
  const rejected = [];
  const bar = FB.createFailBar({
    doc: doc, t: fakeT,
    onRejected: function (spec) { rejected.push(spec.key); },
  });
  bar.raise({ key: 'status.edit-save-failed-cancelled', level: 'P0' });
  assert.strictEqual(bar.raise({ key: 'status.anchor-missing', level: 'P1' }), false);
  assert.strictEqual(doc.els['fail-text'].textContent, 'status.edit-save-failed-cancelled');
  assert.deepStrictEqual(rejected, ['status.anchor-missing']);
  assert.strictEqual(bar.current().level, 'P0');
});

test('动作上限：最多两个 fail-btn ＋ 一个关闭（评审意见 7）', function () {
  const doc = fullDoc();
  const bar = FB.createFailBar({ doc: doc, t: fakeT });
  bar.raise({
    key: 'x', actions: [
      { label: 'fail.retry', run: function () {} },
      { label: 'fail.detail', run: function () {} },
      { label: 'fail.retry', run: function () {} },
    ],
  });
  const list = buttons(doc);
  assert.strictEqual(byClass(list, 'fail-btn').length, 2);
  assert.strictEqual(byClass(list, 'fail-close').length, 1);
  assert.strictEqual(list.length, 3);
});

test('重试在途禁用；成功收起，失败恢复（design/0070 §7-5）', async function () {
  const doc = fullDoc();
  const bar = FB.createFailBar({ doc: doc, t: fakeT });
  let resolveRun;
  bar.raise({
    key: 'status.open-failed',
    actions: [{ label: 'fail.retry', run: function () {
      return new Promise(function (res) { resolveRun = res; });
    } }],
  });
  const retry = byClass(buttons(doc), 'fail-btn')[0];
  retry.listeners.click();
  // ⚠️ 第二次点击必须什么都不做（`busy` 闸）。
  const calls = byClass(buttons(doc), 'fail-btn')[0];
  assert.strictEqual(calls.disabled, true);
  calls.listeners.click();
  assert.strictEqual(doc.els['fail-bar'].hidden, false);

  resolveRun(false);
  await flush();
  assert.strictEqual(doc.els['fail-bar'].hidden, false, '失败后仍须可见');
  assert.strictEqual(byClass(buttons(doc), 'fail-btn')[0].disabled, false);

  // 第二次重试成功 ⇒ 收起（不自动消失，但成功后收）。
  byClass(buttons(doc), 'fail-btn')[0].listeners.click();
  const r2 = resolveRun;
  r2(true);
  await flush();
  assert.strictEqual(doc.els['fail-bar'].hidden, true);
  assert.strictEqual(bar.current(), null);
});

test('详情：按钮切换 aria-expanded 与 #fail-detail 文本', function () {
  const doc = fullDoc();
  const bar = FB.createFailBar({ doc: doc, t: fakeT });
  bar.raise({ key: 'k', detail: 'ENOENT /a/b.md' });
  const detailBtn = byClass(buttons(doc), 'fail-btn')[0];
  assert.strictEqual(detailBtn.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(doc.els['fail-detail'].hidden, true);
  detailBtn.listeners.click();
  const list = buttons(doc);
  const detailBtn2 = byClass(list, 'fail-btn')[0];
  assert.strictEqual(detailBtn2.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(doc.els['fail-detail'].hidden, false);
  assert.strictEqual(doc.els['fail-detail'].textContent, 'ENOENT /a/b.md');
});

test('DOM 缺失走降级出口，而不是静默（§6 失败模型）', function () {
  const doc = fakeDoc({});
  const seen = [];
  const bar = FB.createFailBar({
    doc: doc, t: fakeT,
    onFallback: function (text) { seen.push(text); },
  });
  assert.strictEqual(bar.available(), false);
  assert.strictEqual(bar.raise({ key: 'status.open-failed' }), false);
  assert.deepStrictEqual(seen, ['status.open-failed']);
  assert.strictEqual(bar.current(), null);
});

test('syncScope：离开文档 / 启动页后收起，同文档保留', function () {
  const doc = fullDoc();
  const bar = FB.createFailBar({ doc: doc, t: fakeT });
  bar.raise({ key: 'status.open-failed', scope: { kind: 'doc', path: '/a.md' } });
  assert.strictEqual(bar.syncScope({ docPath: '/a.md', startVisible: false }), false);
  assert.strictEqual(doc.els['fail-bar'].hidden, false);
  assert.strictEqual(bar.syncScope({ docPath: '/b.md', startVisible: false }), true);
  assert.strictEqual(doc.els['fail-bar'].hidden, true);

  bar.raise({ key: 'status.startup-failed', level: 'P0', scope: { kind: 'global' } });
  assert.strictEqual(bar.syncScope({ docPath: '/b.md', startVisible: false }), false);
  assert.strictEqual(doc.els['fail-bar'].hidden, false);
});

test('每次真的显示都回调 onShown（诊断留痕的挂点，INV-FAIL-07）', function () {
  const doc = fullDoc();
  const shown = [];
  const bar = FB.createFailBar({
    doc: doc, t: fakeT,
    onShown: function (spec) { shown.push(spec.key); },
  });
  bar.raise({ key: 'a' });
  bar.raise({ key: 'b' });
  bar.raise({ key: 'c', level: 'P0' });
  bar.raise({ key: 'd', level: 'P1' }); // 被 P0 挡下 ⇒ 不算显示
  assert.deepStrictEqual(shown, ['a', 'b', 'c']);
});

// ────────────────────────────────────────────────────────────────
// ③ 源码级结构闸门（装载位置 / 容器 / 命令清单）
// ────────────────────────────────────────────────────────────────

test('index.html：`#fail-bar` 在 `#status` 之后、`#disk-bar` 之前，且脚本先于 main.js', function () {
  const html = strip(read('src/index.html'));
  const iStatus = html.indexOf('id="status"');
  const iFail = html.indexOf('id="fail-bar"');
  const iDisk = html.indexOf('id="disk-bar"');
  assert.ok(iStatus >= 0 && iFail > iStatus, '#fail-bar 必须在 #status 之后');
  assert.ok(iDisk > iFail, '#fail-bar 必须在 #disk-bar 之前（与其他提示带同层）');
  const iScript = html.indexOf('services/failbar.js');
  const iMain = html.indexOf('src="main.js"');
  assert.ok(iScript >= 0 && iScript < iMain, 'failbar.js 必须在 main.js 之前加载');
});

test('style.css：`.fail-bar[hidden]` 显式压住 display:flex；失败文案不省略', function () {
  const css = strip(read('src/style.css'));
  assert.ok(/\.fail-bar\[hidden\]\s*\{\s*display:\s*none/.test(css), '.fail-bar[hidden] 必须显式声明');
  const textRule = css.match(/\.fail-text\s*\{[^}]*\}/);
  assert.ok(textRule, '缺 .fail-text 规则');
  assert.ok(/overflow-wrap:\s*anywhere/.test(textRule[0]), '失败文案必须换行');
  assert.ok(!/text-overflow:\s*ellipsis/.test(textRule[0]), '失败文案 ⛔ 不许省略');
});

test('`.status` 不再有错误态（isError 从它的 API 里移除）', function () {
  const files = ['src/style.css', 'src/main.js', 'src/index.html'];
  files.forEach(function (f) {
    const src = strip(read(f));
    assert.ok(src.indexOf('status-error') < 0, f + ' 里仍有 status-error');
  });
});

test('折叠顶栏 ⛔ 不许把全局条一起藏掉（INV-CHROME-01，§7-12）', function () {
  const css = strip(read('src/style.css'));
  assert.ok(!/body\.chrome-hidden[^{}]*\.fail-bar/.test(css),
    '`.fail-bar` 进了 `chrome-hidden` —— ⌘⇧B 之后失败会静默消失');
  assert.ok(!/body\.chrome-hidden[^{}]*\.topbar\b/.test(css),
    '别用一刀切：`.topbar` 里还有三条降级提示带');
});

test('diag_note 落在三处清单里（build.rs / capabilities / generate_handler，kb/0007）', function () {
  const build = read('src-tauri/build.rs');
  const caps = read('src-tauri/capabilities/default.json');
  const gui = read('src-tauri/src/gui/mod.rs');
  assert.ok(/"diag_note"/.test(build), 'build.rs 缺 diag_note');
  assert.ok(/"allow-diag-note"/.test(caps), 'capabilities 缺 allow-diag-note');
  assert.ok(/commands::diag_note/.test(gui), 'generate_handler! 缺 diag_note');
});

test('main.js 的 diag_note area/key 全是后端认的形状（否则日志静默缺席）', function () {
  // ⚠️ 后端用**形状**校验 key（全小写 ASCII ＋ `.`/`-`，≤64）——前端写一个 `fileView…`
  //    就会被拒，而拒绝只进 console ⇒ 日志里什么都看不到，正是 `INV-FAIL-07` 要防的。
  const rust = read('src-tauri/src/commands/mod.rs');
  const m = rust.match(/const AREAS: &\[&str\] = &\[([\s\S]*?)\];/);
  assert.ok(m, '找不到 diag_note 的 AREAS 白名单');
  const areas = new Set((m[1].match(/"([^"]+)"/g) || []).map(function (s) { return s.slice(1, -1); }));

  const src = strip(read('src/main.js'));
  const re = /diagNote\(\s*'([^']+)'\s*,\s*'([^']+)'/g;
  let hit;
  let n = 0;
  while ((hit = re.exec(src))) {
    n += 1;
    assert.ok(areas.has(hit[1]), '未登记的 area：' + hit[1] + '（后端会拒，日志缺席）');
    assert.ok(/^[a-z0-9.-]{1,64}$/.test(hit[2]), '不合法的 key 形状：' + hit[2]);
  }
  assert.ok(n >= 20, 'diagNote 调用点只剩 ' + n + ' 处 —— 失败留痕不该这么少');
});
