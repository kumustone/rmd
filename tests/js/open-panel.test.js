// `design/0071` §3（阶段 2：`⌘O` 打开面板，2026-11-14 已通过）的**判据**。
//
// # 这一格守的是什么
//
// 面板上有四类错误**不会报任何错**，只表现为"看起来能用、用起来不对"：
// ① **行序**（`§3.1`）：同一条最近记录展开成"文件行 + 目录行"时，文件行必须在**前**
//    ——反了不会崩，只是每次都要多按一下 ↓。
// ② **上限**：`RECENT_LIMIT = 10` 是「文件行 + 目录行**合计**」，⛔ 不是"每类各 10 条"。
//    按每类算 ⇒ 面板会突然长出 20 行，而没有任何东西会报错。
// ③ **空态**：一条最近都没有时，选中必须落在「浏览目录…」上——
//    否则用户按回车"什么也没发生"，会以为面板坏了。
// ④ **键盘**：`Esc`/`↑`/`↓`/`Enter` 若不在 capture 里拦下，用户以为关了、其实焦点还在
//    浮层里；接着打字全落进黑洞（面板里没有输入框，连"打进去了"都看不见）。
//
// # 判据分三层（⛔ 别混着读）
//
// · **纯逻辑**（`services/openpanel.js`）：排序 / 上限 / 空态 / 键盘映射 / 去重；
// · **源码接线**：脚本顺序、`main.js` 的授权顺序、Rust 单选键位表、CSS 层序；
// · **变异自测**：上面每条判据都得证明自己**真的看了那一眼**。
//
// ⚠️ 本文件⛔ 不引 jsdom：判据要说的是"我们的逻辑对不对"，不是"浏览器对不对"。
//    真 DOM 的行为（焦点回落、滚动跟随）归离屏探针与人工验收。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OP = require('../../src/services/openpanel.js');
const I = require('../../src/services/i18n.js');

const ROOT = path.join(__dirname, '..', '..');
const read = function (p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); };

// 源码里大量写着"⛔ 别写成 X"，所以源码级判据先剥注释（与 `drop.test.js` 同一手法）。
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
    if ((before.match(/["']/g) || []).length % 2 === 1) return line;
    return before;
  }).join('\n');
}

function strip(src) { return stripLineComments(stripBlockComments(src)); }

/** `SessionSnapshot.recent` 的一条记录（后端给的原串，`updated_at` 已由后端排好）。 */
function snap(root, lastFile, last) {
  return { root: root, last_file: lastFile || '', last: last === true };
}

const HOME = '/Users/kumu/docs';

// ── ① 行序：文件行在同一条目录行之前（§3.1） ─────────────────────────

test('文件行排在同一条目录行之前', function () {
  const rows = OP.buildRows([snap(HOME + '/proj', HOME + '/proj/readme.md')]);
  assert.deepStrictEqual(rows.map(function (r) { return r.kind; }), ['file', 'dir']);
  assert.strictEqual(rows[0].path, HOME + '/proj/readme.md');
  assert.strictEqual(rows[1].path, HOME + '/proj');
});

test('没有 last_file 的目录只有一行（⛔ 不画一个空的文件行）', function () {
  const rows = OP.buildRows([snap(HOME + '/a'), snap(HOME + '/b', '')]);
  assert.deepStrictEqual(rows.map(function (r) { return r.kind; }), ['dir', 'dir']);
});

test('多目录时按后端给的顺序展开：目录1文件、目录1、目录2文件、目录2', function () {
  const rows = OP.buildRows([
    snap(HOME + '/a', HOME + '/a/x.md'),
    snap(HOME + '/b', HOME + '/b/y.md'),
  ]);
  assert.deepStrictEqual(rows.map(function (r) { return r.path; }), [
    HOME + '/a/x.md', HOME + '/a', HOME + '/b/y.md', HOME + '/b',
  ]);
});

test('`last` 标记跟随后端：目录行与同目录的文件行都带', function () {
  const rows = OP.buildRows([
    snap(HOME + '/a', HOME + '/a/x.md', true),
    snap(HOME + '/b', HOME + '/b/y.md'),
  ]);
  assert.deepStrictEqual(rows.map(function (r) { return r.kind; }), ['file', 'dir', 'file', 'dir']);
  assert.strictEqual(rows[0].last, true, '文件行要跟着它的目录');
  assert.strictEqual(rows[1].last, true, '目录行自己那条');
  assert.strictEqual(rows[2].last, false);
  assert.strictEqual(rows[3].last, false);
});

// ── ② 上限：文件行 + 目录行**合计** ──────────────────────────────────

test('上限按展开后的合计算：12 个"目录 + 上次文件"只画 10 行', function () {
  const recent = [];
  for (let i = 0; i < 12; i++) recent.push(snap(HOME + '/d' + i, HOME + '/d' + i + '/f.md'));
  const rows = OP.buildRows(recent);
  assert.strictEqual(rows.length, OP.MAX_ROWS, '⛔ 不是"每类各 10 条"');
  assert.strictEqual(rows.length, 10);
});

test('只剩 1 格时文件行优先（它信息量更大，单独点它也能授权那个根）', function () {
  // 4 个"目录 + 上次文件" = 8 行；再一个只有目录的记录 = 9 行；只剩 1 格。
  const recent = [];
  for (let i = 0; i < 4; i++) recent.push(snap(HOME + '/d' + i, HOME + '/d' + i + '/f.md'));
  recent.push(snap(HOME + '/plain'));
  recent.push(snap(HOME + '/tail', HOME + '/tail/last.md'));
  const rows = OP.buildRows(recent);
  assert.strictEqual(rows.length, 10);
  assert.strictEqual(rows[9].kind, 'file', '最后一格被目录行抢走了');
  assert.strictEqual(rows[9].path, HOME + '/tail/last.md');
});

test('自定义 limit 生效；0 / 负值回落默认 10（⛔ 不画成空面板）', function () {
  const recent = [snap(HOME + '/a', HOME + '/a/x.md'), snap(HOME + '/b', HOME + '/b/y.md')];
  assert.strictEqual(OP.buildRows(recent, 3).length, 3);
  assert.strictEqual(OP.buildRows(recent, 0).length, 4);
  assert.strictEqual(OP.buildRows(recent, -1).length, 4);
});

// ── ③ 空态与两条浏览行 ───────────────────────────────────────────────

test('空态：没有最近行时选中 0 = 「浏览目录…」', function () {
  const items = OP.buildRows([]).concat(OP.browseRows());
  assert.deepStrictEqual(items.map(function (r) { return r.kind; }), ['browse', 'browse']);
  const sel = OP.initialSelection(items);
  assert.strictEqual(sel, 0, '空态回车必须落在「浏览目录…」上（§3.1）');
  assert.strictEqual(items[sel].target, 'dir');
});

test('两条浏览行的顺序是 目录 → 文件（与老的两个入口同序）', function () {
  assert.deepStrictEqual(OP.browseRows().map(function (r) { return r.target; }), ['dir', 'file']);
});

test('browseRows 每次返回新对象（⛔ 共享可变单例）', function () {
  const a = OP.browseRows();
  a[0].target = 'file';
  a.push({ kind: 'browse', target: 'evil' });
  assert.strictEqual(OP.browseRows()[0].target, 'dir');
  assert.strictEqual(OP.browseRows().length, 2);
});

test('initialSelection：完全空列表才返回 -1', function () {
  assert.strictEqual(OP.initialSelection([]), -1);
  assert.strictEqual(OP.initialSelection(null), -1);
  assert.strictEqual(OP.initialSelection([{ kind: 'dir' }]), 0);
});

// ── ④ 键盘映射（纯函数） ──────────────────────────────────────────────

test('按键映射：Esc 关、↓/↑ 移动、Enter 打开、Tab 收回面板', function () {
  assert.strictEqual(OP.actionForKey({ key: 'Escape' }), 'close');
  assert.strictEqual(OP.actionForKey({ key: 'ArrowDown' }), 'down');
  assert.strictEqual(OP.actionForKey({ key: 'ArrowUp' }), 'up');
  assert.strictEqual(OP.actionForKey({ key: 'Enter' }), 'pick');
  assert.strictEqual(OP.actionForKey({ key: 'Tab' }), 'focus');
});

test('按键映射：其余键一律放行（全局键归 main.js 的分发器）', function () {
  for (const k of ['o', 'p', 'a', ' ', 'Backspace', 'PageDown', 'F2', 'Process']) {
    assert.strictEqual(OP.actionForKey({ key: k }), '', k + ' 被面板吞了');
  }
  assert.strictEqual(OP.actionForKey(null), '');
  assert.strictEqual(OP.actionForKey({}), '');
  assert.strictEqual(OP.actionForKey({ key: 13 }), '');
});

test('移动环绕；越界选中归 0；没有可选项时 -1', function () {
  assert.strictEqual(OP.move(0, 1, 3), 1);
  assert.strictEqual(OP.move(2, 1, 3), 0, '底部再按 ↓ 回顶部（与 QuickOpen 同形）');
  assert.strictEqual(OP.move(0, -1, 3), 2, '顶部再按 ↑ 到底部');
  assert.strictEqual(OP.move(-1, 1, 3), 1, '无选中时先归 0 再走一格');
  assert.strictEqual(OP.move(9, 1, 3), 1, '陈旧下标同上');
  assert.strictEqual(OP.move(0, 1, 0), -1);
  assert.strictEqual(OP.move(0, 1, -2), -1);
});

// ── ⑤ 去重与坏行 ────────────────────────────────────────────────────

test('同一条最近记录重复出现只画一次（护栏：用户会看到两行一样的字）', function () {
  const one = snap(HOME + '/a', HOME + '/a/x.md');
  const rows = OP.buildRows([one, one]);
  assert.deepStrictEqual(rows.map(function (r) { return r.kind; }), ['file', 'dir']);
});

test('两个目录指向同一个 last_file 时也只画一次（按 kind+path 去重）', function () {
  const rows = OP.buildRows([
    snap(HOME + '/a', HOME + '/shared.md'),
    snap(HOME + '/b', HOME + '/shared.md'),
  ]);
  const files = rows.filter(function (r) { return r.kind === 'file'; });
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].root, HOME + '/a', '保留先出现的那一条');
});

test('坏行跳过而不是画一行空白（点下去必然失败）', function () {
  const rows = OP.buildRows([null, undefined, {}, { root: '' }, { root: 7 }, snap(HOME + '/ok')]);
  assert.deepStrictEqual(rows.map(function (r) { return r.path; }), [HOME + '/ok']);
  assert.deepStrictEqual(OP.buildRows('not-an-array'), []);
  assert.deepStrictEqual(OP.buildRows(null), []);
});

// ── ⑥ 显示口径：name / dir 只用于显示，path / root 是原串 ────────────

test('文件行的 path 是 last_file 原串，dir 是 ~ 缩写', function () {
  const rows = OP.buildRows([snap(HOME + '/proj/', HOME + '/proj/sub/a.md')]);
  assert.strictEqual(rows[0].path, HOME + '/proj/sub/a.md', '回传的必须是原串');
  assert.strictEqual(rows[0].root, HOME + '/proj/');
  assert.strictEqual(rows[0].name, 'a.md');
  assert.strictEqual(rows[0].dir, '~/docs/proj/');
  assert.strictEqual(rows[1].name, 'proj', '尾部分隔符不算名字的一段');
  assert.strictEqual(rows[1].path, HOME + '/proj/', '目录行的 path 是 root 原串');
});

test('显示换算复用 `services/start.js`（⛔ 第二份 tilde/basename）', function () {
  const src = strip(read('src/services/openpanel.js'));
  assert.ok(src.indexOf("require('./start.js')") >= 0 ||
    src.indexOf('window.rmd.start') >= 0, 'openpanel.js 没有复用 start.js 的显示换算');
  assert.strictEqual(src.indexOf('replace(/^\\/Users\\/'), -1, '又抄了一份 tilde');
});

// ── ⑦ 源码接线 ──────────────────────────────────────────────────────

test('index.html 顺序：依赖先加载，OpenPanel 在 main.js 之前', function () {
  const html = read('src/index.html');
  const at = function (p) {
    const i = html.indexOf('src="' + p + '"');
    assert.ok(i >= 0, 'index.html 没有加载 ' + p);
    return i;
  };
  const openpanel = at('services/openpanel.js');
  const comp = at('components/OpenPanel.js');
  assert.ok(at('services/start.js') < openpanel, 'openpanel.js 加载期取 window.rmd.start');
  assert.ok(at('services/i18n.js') < comp, 'OpenPanel.js 加载期取 i18n');
  assert.ok(at('services/keymap.js') < comp, 'OpenPanel.js 加载期取 keymap');
  assert.ok(openpanel < comp, 'OpenPanel.js 加载期取 openpanel');
  assert.ok(at('components/Settings.js') < comp, 'OpenPanel.js 加载期取 Settings');
  assert.ok(comp < at('main.js'), 'main.js 加载期取 window.rmd.openPanel');
});

test('`⌘O` 注册到 `file.open`，旧 id 在 `src/` 里已无引用', function () {
  const main = strip(read('src/main.js'));
  assert.ok(/keymap\.register\('file\.open',/.test(main), 'main.js 没有注册 file.open');
  assert.strictEqual(main.indexOf('file.open-directory'), -1, '旧 id 还在 main.js 里');
  const gui = strip(read('src-tauri/src/gui/mod.rs'));
  assert.strictEqual(gui.indexOf('"file.open-directory"'), -1, '旧 id 还在 Rust 表里');
});

test('文件行先授权根、再开文件；同一份已经恢复过就不重复打开', function () {
  const main = strip(read('src/main.js'));
  const fn = main.slice(main.indexOf('async function onOpenPanelPick'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  const auth = body.indexOf('onOpenRecentDirectory(row.root)');
  const open = body.indexOf('openDocument(row.path)');
  assert.ok(auth >= 0, '文件行没有先走 onOpenRecentDirectory（最近记录不是授权，INV-FS-03）');
  assert.ok(open > auth, 'openDocument 必须在授权之后（⛔ 顺序换了就是"未授权读盘"）');
  assert.ok(body.indexOf('S.state.currentPath === row.path') >= 0,
    '少了"恢复流程已经打开了这一份"的判据（会重复打开）');
  // 目录行走的是与启动页**同一条**路（`INV-OPEN-02`），⛔ 别在面板里另写一套。
  assert.ok(/row\.kind === 'dir'[\s\S]{0,200}onOpenRecentDirectory\(row\.root\)/.test(body));
});

test('失败出口走 `#fail-bar`，⛔ 不在面板里内联（面板选中即关）', function () {
  const main = strip(read('src/main.js'));
  assert.ok(/reportOpenPanelFailure\(res\)/.test(main));
  const comp = strip(read('src/components/OpenPanel.js'));
  assert.strictEqual(comp.indexOf('fail-bar'), -1, '组件自己碰了失败条（应交给 main.js）');
  assert.strictEqual(comp.indexOf('raiseFail'), -1, '组件自己造了失败记录');
});

test('数据只有一份：`recent` 是现取 `S.state.recent`（INV-OPEN-05）', function () {
  const main = strip(read('src/main.js'));
  assert.ok(/recent:\s*function\s*\(\)\s*\{\s*return S\.state\.recent;\s*\}/.test(main),
    'main.js 没有把 S.state.recent 现取进来（缓存一份的话启动页删掉后面板不会同步）');
  // 组件侧也必须**每次 open() 现取**，⛔ 在 create* 时取一次存着。
  const comp = strip(read('src/components/OpenPanel.js'));
  const openFn = comp.slice(comp.indexOf('function open()'));
  const openBody = openFn.slice(0, openFn.indexOf('\n    }\n'));
  assert.ok(openBody.indexOf('getRecent()') >= 0, 'open() 没有现取 recent');
});

test('Rust：`file.open` = ⌘O，`⇧⌘O` 仍是 `file.open-file`（⛔ 两个都动了）', function () {
  const gui = strip(read('src-tauri/src/gui/mod.rs'));
  const entry = function (id) {
    const i = gui.indexOf('id: "' + id + '",');
    assert.ok(i >= 0, 'SHORTCUTS 里少了 ' + id);
    const block = gui.slice(i, gui.indexOf('},', i));
    const accel = /accel:\s*"([^"]+)"/.exec(block);
    return accel ? accel[1] : '';
  };
  assert.strictEqual(entry('file.open'), 'Cmd+O');
  assert.strictEqual(entry('file.open-file'), 'Shift+Cmd+O', '⇧⌘O 的语义一个字没动');
});

test('组件里没有键位字面量（INV-SET-01：表在 Rust，⛔ 前端抄一份）', function () {
  // 剥注释之后再查：文件头写着"`⌘O` 出来"，那是说明，⛔ 不是实现。
  const comp = strip(read('src/components/OpenPanel.js'));
  assert.strictEqual(comp.indexOf('Cmd+'), -1, 'OpenPanel.js 出现 Cmd+ 字面量');
  assert.strictEqual(comp.indexOf('⌘'), -1, 'OpenPanel.js 出现 ⌘ 字形');
  assert.strictEqual(comp.indexOf('metaKey'), -1, '修饰键判据只能在 keymap.js');
});

test('i18n 两张表都有面板那七条 + 状态栏那条', function () {
  const keys = ['open.title', 'open.recent', 'open.browse-dir', 'open.browse-file',
    'open.empty', 'open.row-file', 'open.row-dir', 'status.ready-open'];
  for (const k of keys) {
    assert.ok(I.has(k, 'zh'), k + ' 缺中文');
    assert.ok(I.has(k, 'en'), k + ' 缺英文');
  }
});

test('CSS：面板层序 40、`[hidden]` 显式关掉、⛔ 无字面色值', function () {
  const css = strip(read('src/style.css'));
  const i = css.indexOf('.openpanel-layer {');
  assert.ok(i >= 0, 'style.css 少了 .openpanel-layer');
  const block = css.slice(i, css.indexOf('}', i));
  const z = /z-index:\s*(\d+)/.exec(block);
  assert.ok(z, '面板层必须给 z-index');
  assert.strictEqual(z[1], '40', '面板与 ⌘P / 设置同层（层序：正文 10–30 / 就地编辑 35 / 40 / 查找 45 / 看图 50）');
  assert.ok(css.indexOf('.openpanel-layer[hidden]') >= 0,
    '[hidden] 必须显式写（UA 那条压不住类选择器）');
  // ⚠️ 字面色值由 `make lint-theme` 守；这里只证"这一块不是靠字面色值过日子的"。
  const all = css.slice(css.indexOf('/* `⌘O`'), css.length);
  assert.strictEqual(/#[0-9a-fA-F]{3,8}\b/.test(all), false, '面板样式出现十六进制色');
  assert.strictEqual(/rgba?\(/.test(all), false, '面板样式出现 rgba 字面量');
});

// ── ⑧ 变异自测：判据自己承不承重 ─────────────────────────────────────

/** 在隔离上下文里跑一份改过的 `openpanel.js`（⛔ 不改磁盘，与 `drop.test.js` 同法）。 */
function mutatedOpenpanel(src) {
  const ctx = {
    module: { exports: {} },
    console: console,
    require: function (p) { return require(path.join(ROOT, 'src/services', p)); },
  };
  vm.runInNewContext(src, ctx);
  return ctx.module.exports;
}

test('变异自测：把文件行挪到目录行之后，"文件行在前"必须变红', function () {
  const src = read('src/services/openpanel.js');
  const a = src.indexOf('      if (typeof r.last_file');
  const b = src.indexOf("      put(out, seen, cap, {\n        kind: 'dir',");
  const end = src.indexOf('      if (out.length >= cap) break;', b);
  assert.ok(a >= 0 && b > a && end > b, '变异靶子漂移了（找不到文件行 / 目录行那两段）');
  const mutated = src.slice(0, a) + src.slice(b, end) + src.slice(a, b) + src.slice(end);
  assert.notStrictEqual(mutated, src);
  const M = mutatedOpenpanel(mutated);
  const rows = M.buildRows([snap(HOME + '/proj', HOME + '/proj/readme.md')]);
  assert.strictEqual(rows[0].kind, 'dir', '换序之后判据还绿 —— 它不承重');
});

test('变异自测：上限改成"每类各 10 条"，合计上限判据必须变红', function () {
  const src = read('src/services/openpanel.js');
  let mutated = src.replace('if (out.length >= cap) return;', 'if (false) return;');
  mutated = mutated.replace('if (out.length >= cap) break;', 'void 0;');
  assert.notStrictEqual(mutated, src, '变异没命中目标 —— 上限判据的靶子漂移了');
  const M = mutatedOpenpanel(mutated);
  const recent = [];
  for (let i = 0; i < 12; i++) recent.push(snap(HOME + '/d' + i, HOME + '/d' + i + '/f.md'));
  assert.ok(M.buildRows(recent).length > 10, '去掉上限之后判据还绿 —— 它不承重');
});

test('变异自测：Enter 不再映射成 pick，键盘判据必须变红', function () {
  const src = read('src/services/openpanel.js');
  const mutated = src.replace("case 'Enter': return 'pick';", "case 'Enter': return '';");
  assert.notStrictEqual(mutated, src, '变异没命中目标 —— 键盘判据的靶子漂移了');
  const M = mutatedOpenpanel(mutated);
  assert.strictEqual(M.actionForKey({ key: 'Enter' }), '', '回车被吞之后判据还绿 —— 它不承重');
});

test('变异自测：`onOpenPanelPick` 里先开文件后授权，顺序判据必须能抓到', function () {
  // 判据本体是"两个 indexOf 的先后"；这里用一段假源码证明它**真的在比大小**。
  const order = function (body) {
    const auth = body.indexOf('onOpenRecentDirectory(row.root)');
    const open = body.indexOf('openDocument(row.path)');
    return auth >= 0 && open > auth;
  };
  assert.strictEqual(order('onOpenRecentDirectory(row.root); openDocument(row.path);'), true);
  assert.strictEqual(order('openDocument(row.path); onOpenRecentDirectory(row.root);'), false,
    '颠倒顺序判据还绿 —— 它不承重');
  assert.strictEqual(order('openDocument(row.path);'), false);
});

test('变异自测：源码闸门能抓到写进代码的 `⌘`，但⛔ 不被注释绊倒', function () {
  const real = 'if (e.key === "o" && e.metaKey) { open(); } // ⌘O';
  assert.ok(strip(real).indexOf('metaKey') >= 0, '闸门的判据串没命中真实代码形态');
  const commentOnly = '// 按 ⌘O 出来\nconst x = 1;';
  assert.strictEqual(strip(commentOnly).indexOf('⌘'), -1, '剥注释没生效 —— 闸门会把说明判成实现');
});
