// `design/0038`（启动页与打开入口，2026-10-24 已通过）的**判据**。
//
// # 三层，各自守一类失效
//
// ① **纯逻辑**（`services/start.js`）：行换算 / 数字键映射 / 五种放行。
//    这些错法**全是静默的**——列表顺序错了、第 9 行点出第 8 行、`⌘O` 被启动页吞掉，
//    屏幕上都不会报任何东西。
// ② **源码级结构闸门**：启动页的**唯一挂载点**、五种放行的**五个字段**、
//    `File` 菜单那三行的 id 与分隔线、`open_recent_directory` 的**三处清单**。
//    ⚠️ 最后一条尤其重要：漏了 ACL 是**静默拒**（`docs/kb/0007`），
//    表现是"点一行毫无反应、`⌘O` 照常"。
// ③ **变异自测**：同一套判据喂给"故意写坏的副本"必须变红——
//    否则"全绿"只说明判据没看那一眼（`tests.md` 的四种"没红"）。
//
// ⚠️ 判据对**注释免疫**：本仓注释里大量写着"⛔ 别写成 X"，直接 grep 原文会把
//    正确的注释判成缺陷 ⇒ 所有源码级判据都在 `strip*` 之后跑。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Start = require('../../src/services/start.js');

const ROOT = path.join(__dirname, '..', '..');
const read = function (p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); };

/** 挖空 `/* … *\/`（保留换行，行号仍然对得上）。 */
function stripBlockComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

/** 挖空 `// …`（保守：`//` 前面有奇数个引号就当作还在字符串里，不动）。 */
function stripLineComments(src) {
  return String(src).split('\n').map(function (line) {
    const i = line.indexOf('//');
    if (i < 0) return line;
    const before = line.slice(0, i);
    if (((before.match(/["']/g) || []).length % 2) === 1) return line;
    return before;
  }).join('\n');
}

const stripJs = function (src) { return stripLineComments(stripBlockComments(src)); };

const SRC = {
  main: stripJs(read('src/main.js')),
  screen: stripJs(read('src/components/StartScreen.js')),
  session: stripJs(read('src/services/session.js')),
  sidebar: stripJs(read('src/components/Sidebar.js')),
  rust: stripJs(read('src-tauri/src/gui/mod.rs')),
  build: stripJs(read('src-tauri/build.rs')),
  cap: read('src-tauri/capabilities/default.json'),
  css: stripBlockComments(read('src/style.css')),
  html: stripBlockComments(read('src/index.html')),
  start: stripJs(read('src/services/start.js')),
};

// ────────────────────────────────────────────────────────────────
// ① 纯逻辑
// ────────────────────────────────────────────────────────────────

test('rows：后端顺序原样保留，⛔ 不排序（排序是后端的职责）', function () {
  const recent = [
    { root: '/a/b', last_file: '/a/b/x.md', updated_at: 5, last: false },
    { root: '/c', last_file: null, updated_at: 9, last: true },
  ];
  const rows = Start.rows(recent);
  assert.deepStrictEqual(rows.map(function (r) { return r.root; }), ['/a/b', '/c'],
    '⛔ 前端不许按 updated_at 再排一次——那是第二份派生规则');
  assert.strictEqual(rows[0].name, 'b');
  assert.strictEqual(rows[0].path, '/a/b');
  assert.strictEqual(rows[0].file, 'x.md', '上次读的文件只显示**文件名**');
  assert.strictEqual(rows[1].file, '', '没有 last_file ⇒ 空串（界面上那一格不画）');
  assert.strictEqual(rows[1].last, true);
});

test('rows：上限 10 条（配置里存 20，界面只显示 10）', function () {
  const recent = [];
  for (let i = 0; i < 20; i++) recent.push({ root: '/r' + i, last_file: null, updated_at: i, last: false });
  const rows = Start.rows(recent);
  assert.strictEqual(rows.length, 10);
  assert.strictEqual(rows[0].root, '/r0', '截掉的是**尾部**（后端已按新旧排好）');
  assert.strictEqual(Start.MAX_ROWS, 10);
});

test('rows：坏行跳过、非数组退回空（空 ⇒ 启动页与今天逐字节相同）', function () {
  assert.deepStrictEqual(Start.rows(null), []);
  assert.deepStrictEqual(Start.rows(undefined), []);
  assert.deepStrictEqual(Start.rows({}), []);
  const rows = Start.rows([null, { root: '' }, { last_file: '/x.md' }, { root: '/ok' }]);
  assert.deepStrictEqual(rows.map(function (r) { return r.root; }), ['/ok'],
    '⚠️ 坏行必须跳过：画一行空白 ⇒ 点下去必然被后端拒绝，用户会以为目录坏了');
});

// ⭐ `design/0043` §2.6：收藏段的行换算。三条**静默**错法各有判据：
//    ① 排序/过滤（"我排好的顺序被打乱了" / "收藏着却看不见了"）；
//    ② 丢原串（点击时拿显示用的 `~` 缩写回传 ⇒ 后端逐字比对必然拒绝）；
//    ③ 画坏行（一行没有名字的按钮，点下去必然被拒）。
test('favoriteRows：原串回传、顺序原样、不按存在性过滤', function () {
  const favs = ['/Users/example/workspace/rmd', '/opt/docs', '/Users/example/中文目录'];
  const rows = Start.favoriteRows(favs);
  assert.deepStrictEqual(rows.map(function (r) { return r.path; }), favs,
    '⚠️ 顺序必须原样（那是用户用上移/下移排出来的），且回传的是**后端记录的原串**');
  assert.deepStrictEqual(rows.map(function (r) { return r.name; }),
    ['rmd', 'docs', '中文目录']);
  assert.deepStrictEqual(rows.map(function (r) { return r.tilded; }),
    ['~/workspace/rmd', '/opt/docs', '~/中文目录']);
  // ⚠️ 名字/缩写**只用于显示**：原串与它们不是同一个字符串
  assert.notStrictEqual(rows[0].path, rows[0].tilded);
});

test('favoriteRows：坏行跳过、非数组退回空、不截断', function () {
  assert.deepStrictEqual(Start.favoriteRows(null), []);
  assert.deepStrictEqual(Start.favoriteRows(undefined), []);
  assert.deepStrictEqual(Start.favoriteRows({}), []);
  assert.deepStrictEqual(
    Start.favoriteRows([null, '', 42, '/ok']).map(function (r) { return r.path; }),
    ['/ok'],
    '⚠️ 坏行必须跳过：画一行空白 ⇒ 点下去必然被后端拒绝'
  );
  // ⚠️ 与最近表不同：收藏**不截断**（`MAX_ROWS` 只管最近表；上限在后端）
  const many = [];
  for (let i = 0; i < Start.MAX_ROWS + 5; i++) many.push('/d' + i);
  assert.strictEqual(Start.favoriteRows(many).length, many.length,
    '收藏段不该按最近表的上限截断（上限的真值在后端）');
});

// ⭐ `design/0081` §2.1 ③：导航页「开始」段的动作清单。
//    ⚠️ 这里只管**有哪些动作、按什么顺序**：文案与键位来自后端 `SHORTCUTS` 表
//    （`INV-START-08`），本模块拿不到也不该拿。
test('actionRows：顺序固定为 打开 → 打开文件 → 快速打开', function () {
  assert.deepStrictEqual(Start.actionRows(true),
    ['file.open', 'file.open-file', 'file.quick-open']);
  assert.deepStrictEqual(Start.actionRows(false),
    ['file.open', 'file.open-file'],
    '⚠️ 「快速打开…」只在目录模式（可用）时出现——画一行点了没反应的入口比少画一行更糟');
});

test('actionRows：只有 `true` 才算可用（⛔ 真值判断）', function () {
  // ⚠️ 与 `theme.js` 的 `vim_mode` 同一条纪律：`"false"` / `1` 这种值不该让这一行冒出来。
  const withQuick = function (rows) { return rows.indexOf('file.quick-open') >= 0; };
  assert.strictEqual(withQuick(Start.actionRows(true)), true);
  [false, null, undefined, 0, 1, 'true', 'false', {}].forEach(function (v) {
    assert.strictEqual(withQuick(Start.actionRows(v)), false, '非 true ⇒ 不画快速打开（拿到 ' + String(v) + '）');
  });
});

test('tilde / basename 的边界（都**只用于显示**）', function () {
  assert.strictEqual(Start.tilde('/Users/example/workspace/rmd'), '~/workspace/rmd');
  assert.strictEqual(Start.tilde('/opt/x'), '/opt/x', '不是家目录就不改');
  assert.strictEqual(Start.tilde(null), '');

  assert.strictEqual(Start.basename('/a/b'), 'b');
  assert.strictEqual(Start.basename('/a/b/'), 'b', '尾部分隔符要剥掉（否则名字是空串）');
  assert.strictEqual(Start.basename('/'), '/', '根目录回落成 `/`（⛔ 不画一行没有名字的按钮）');
  assert.strictEqual(Start.basename(''), '');
  assert.strictEqual(Start.basename('plain.md'), 'plain.md');
});

test('digitIndex：只认 1–9（0 与多字符一律 -1）', function () {
  assert.strictEqual(Start.digitIndex('1'), 0);
  assert.strictEqual(Start.digitIndex('9'), 8);
  assert.strictEqual(Start.digitIndex('0'), -1, '⛔ 0 不映射（Startify 默认也没有）');
  assert.strictEqual(Start.digitIndex('10'), -1);
  assert.strictEqual(Start.digitIndex('a'), -1);
  assert.strictEqual(Start.digitIndex('ArrowDown'), -1);
  assert.strictEqual(Start.digitIndex(undefined), -1);
});

// ⭐ `design/0045`（隐私）：「清空最近的目录」的**两步确认**。
//
// ⚠️ 判据只有一条实质：**第一下永远不清空**。三个反向错法全是静默的：
//    ① 把"上膛"写成"直接执行" ⇒ 手一滑整份历史没了；
//    ② 窗口过期后仍执行 ⇒ 用户以为取消了，下次顺手一点却清掉；
//    ③ 时钟倒退当成"窗口内" ⇒ 同 ②，且更难复现（改系统时间/休眠唤醒之后）。
test('clearConfirm：第一下只上膛，⛔ 不清空', function () {
  assert.deepStrictEqual(Start.clearConfirm(0, 1000), { fire: false, nextArmedAt: 1000 });
  assert.strictEqual(Start.CLEAR_CONFIRM_MS, 3000, '窗口与 `StartScreen` 的定时器同源，⛔ 别各写一份');
});

test('clearConfirm：窗口内第二下才真清空（含边界值）', function () {
  assert.deepStrictEqual(Start.clearConfirm(1000, 1000), { fire: true, nextArmedAt: 0 },
    '同一毫秒内两次点击也算确认（差值 0 ≤ 窗口）');
  assert.deepStrictEqual(Start.clearConfirm(1000, 3999), { fire: true, nextArmedAt: 0 });
  assert.deepStrictEqual(Start.clearConfirm(1000, 4000), { fire: true, nextArmedAt: 0 },
    '恰好等于窗口的那一下仍算确认（≤ 不是 <）');
  // ⚠️ 执行后复位成 0 ⇒ 下一次点击重新回到"第一下"
  assert.deepStrictEqual(Start.clearConfirm(0, 4001), { fire: false, nextArmedAt: 4001 });
});

test('clearConfirm：超出窗口 ⇒ 当成新的第一下（⛔ 不把迟疑当确认）', function () {
  assert.deepStrictEqual(Start.clearConfirm(1000, 4001), { fire: false, nextArmedAt: 4001 });
  assert.deepStrictEqual(Start.clearConfirm(1000, 60000), { fire: false, nextArmedAt: 60000 });
});

test('clearConfirm：时钟倒退 / 非法"已上膛"值 ⇒ 一律回到第一下', function () {
  assert.deepStrictEqual(Start.clearConfirm(1000, 500), { fire: false, nextArmedAt: 500 },
    '时钟倒退不能算确认（那会让一次随手的点击清空历史）');
  assert.deepStrictEqual(Start.clearConfirm(0, 500), { fire: false, nextArmedAt: 500 });
  assert.deepStrictEqual(Start.clearConfirm(-1, 500), { fire: false, nextArmedAt: 500 });
  assert.deepStrictEqual(Start.clearConfirm(null, 500), { fire: false, nextArmedAt: 500 });
  assert.deepStrictEqual(Start.clearConfirm('1000', 1200), { fire: false, nextArmedAt: 1200 },
    '⛔ 别把字符串当真值用（`"1000" > 0` 成立，但减法是 NaN）');
});

test('guard：五项任一成立就放行；缺省一律按"成立"（宁可少处理一个键）', function () {
  const open = {
    defaultPrevented: false, modifier: false, composing: false, overlay: false, editable: false,
  };
  assert.strictEqual(Start.guard(open), false, '五项都干净 ⇒ 启动页可以处理');
  ['defaultPrevented', 'modifier', 'composing', 'overlay', 'editable'].forEach(function (k) {
    const s = Object.assign({}, open);
    s[k] = true;
    assert.strictEqual(Start.guard(s), true, k + ' 成立时必须放行');
  });
  // ⚠️ 缺省按"成立"：参数漏一个 ⇒ 放行（⛔ 不许因为漏传就吞掉别人的键）
  assert.strictEqual(Start.guard({}), true);
  assert.strictEqual(Start.guard(), true);
});

// ────────────────────────────────────────────────────────────────
// ② 源码级结构闸门
// ────────────────────────────────────────────────────────────────

/**
 * @param {object} s 见 `SRC`（全部是**已剥注释**的源码）
 * @returns {string[]} 失败项（空 = 全过）
 */
function score(s) {
  const bad = [];

  // ── INV-START-01：启动页只活在 `#doc` 空态里 ──
  const creates = (s.main.match(/createStartScreen\(/g) || []).length;
  if (creates !== 1) bad.push('main.js 里 createStartScreen 出现 ' + creates + ' 次（应恰好 1 次）');
  const renders = (s.main.match(/startScreen\.render\(/g) || []).length;
  if (renders !== 1) bad.push('main.js 里 startScreen.render 出现 ' + renders + ' 次（应恰好 1 次：唯一挂载点）');
  const fnAt = s.main.indexOf('function showDocEmpty(');
  const nextAt = s.main.indexOf('function showDocEmptyT(');
  const renderAt = s.main.indexOf('startScreen.render(');
  if (fnAt < 0) bad.push('main.js 找不到 showDocEmpty');
  else if (!(renderAt > fnAt && (nextAt < 0 || renderAt < nextAt))) {
    bad.push('startScreen.render 不在 showDocEmpty 里 —— 有正文时启动页会留在屏幕上（INV-START-01）');
  }
  // 正文挂上来之前必须显式摘监听（innerHTML 摘不掉 document 级 keydown）
  if (!/startScreen\.clear\(\);[\s\S]{0,300}?doc\.innerHTML\s*=/.test(s.main)) {
    bad.push('openDocument 没有在 innerHTML 之前 startScreen.clear()（正文在屏上按 1 仍会打开目录）');
  }
  // ⭐ 数据只有一个来源：快照的 `recent`。⚠️ `design/0071` §3（2026-11-14 批准）起有**两个**读者
  //    ——启动页（`INV-START-01`）与 `⌘O` 面板的 `recent` 取值器（`INV-OPEN-05`，⛔ 不建第二份缓存）
  //    ——所以闸门**点名这两处**，⛔ 不再只数字面次数：数目对了但第三处偷偷抄一份
  //    （`var r = S.state.recent`）才是这条要防的形态。
  const START_READ = /startScreen\.render\(box, S\.state\.recent, S\.state\.favorites\)/;
  const PANEL_READ = /recent:\s*function\s*\(\)\s*\{\s*return S\.state\.recent;\s*\}/;
  if (!START_READ.test(s.main)) bad.push('main.js 没把 S.state.recent 递给启动页（INV-START-01）');
  if (!PANEL_READ.test(s.main)) bad.push('main.js 没把 S.state.recent 递给 ⌘O 面板（INV-OPEN-05）');
  const fromState = (s.main.match(/S\.state\.recent/g) || []).length;
  if (fromState !== 2) bad.push('main.js 取 S.state.recent ' + fromState + ' 次（应恰好 2 次：启动页 ＋ ⌘O 面板）');
  if (!/state\.recent\s*=\s*snap\.recent\s*\|\|\s*\[\]/.test(s.session)) {
    bad.push('session.js 的 applySnapshot 没有 state.recent = snap.recent || []（INV-START-05）');
  }
  // ⛔ 前端不许从别的数据再推一份"最近"（dirSession / reading_progress）
  if (/recent[^\n]*reading_progress|reading_progress[^\n]*recent/.test(s.start)) {
    bad.push('services/start.js 从 reading_progress 推了"最近" —— 那是第二个真值（INV-START-05）');
  }

  // ── INV-START-04：五种放行，五个字段都得**当场算** ──
  const guardAt = s.screen.indexOf('Start.guard({');
  if (guardAt < 0) bad.push('StartScreen.js 没有调 Start.guard（⛔ 判据只许有一份）');
  else {
    const blk = s.screen.slice(guardAt, guardAt + 400);
    ['defaultPrevented', 'modifier', 'composing', 'overlay', 'editable'].forEach(function (k) {
      if (!new RegExp('\\b' + k + ':').test(blk)) {
        bad.push('放行判据里缺 `' + k + '` 那一项（INV-START-04 缺一不可）');
      }
    });
  }
  ['hasModifier', 'isComposingEvent', 'isEditableElement'].forEach(function (fn) {
    if (!new RegExp('K\\.' + fn + '\\(').test(s.screen)) {
      bad.push('StartScreen.js 没有转调 K.' + fn + '（⛔ 不许另写一份修饰键/组合态判据）');
    }
  });
  if (!/overlayOpen\(\)/.test(s.screen)) bad.push('StartScreen.js 没判"覆盖层开着"');
  // ⚠️ **不预选、不抢焦点**：`render()` 里一次 `.focus()` 都不许有。
  //    `design/0043` 起另有三处**用户刚刚亲手触发**的焦点移动（⛔ 不是自动预选）：
  //    ① `↑`/`↓` 在行之间移动；② `Shift+F10` 打开菜单时焦点进第一项；
  //    ③ `Escape` 关菜单把焦点还给那一行。三处各**恰好一次**，多一处必红。
  const focusAllowed = [
    'els[next].focus();',
    'if (first) first.focus();',
    'if (restoreFocus && owner && owner.isConnected) owner.focus();',
  ];
  focusAllowed.forEach(function (snippet) {
    const n = s.screen.split(snippet).length - 1;
    if (n !== 1) bad.push('StartScreen.js 里 `' + snippet + '` 出现 ' + n + ' 次（应恰好 1 次）');
  });
  const focuses = (s.screen.match(/\.focus\(\)/g) || []).length;
  if (focuses !== focusAllowed.length) {
    bad.push('StartScreen.js 里 .focus() 出现 ' + focuses + ' 次（应恰好 ' + focusAllowed.length +
      ' 次，且都在这三处：↑↓ 移动 / 菜单首项 / Escape 还原）');
  }
  // ⚠️ `render()` 那一段里不许有任何 `.focus(`（自动预选就是从这里溜进来的）
  const renderFnAt = s.screen.indexOf('function render(');
  if (renderFnAt >= 0) {
    const nextFn = s.screen.indexOf('\n    function ', renderFnAt + 10);
    const body = s.screen.slice(renderFnAt, nextFn > 0 ? nextFn : s.screen.length);
    if (/\.focus\(/.test(body)) bad.push('render() 里出现了 .focus() —— 启动页不许自动预选/抢焦点');
  }
  // ⚠️ 只在启动页可见期挂：guard 前置的 `if (!box) return;`
  if (!/function onKeyDown\(e\)\s*\{\s*if\s*\(!box\)\s*return;/.test(s.screen)) {
    bad.push('onKeyDown 没有 `if (!box) return;` —— 启动页不在屏上时仍在处理按键');
  }

  // ── INV-START-07：打不开必须可见 ──
  // ⚠️ 标的是 `data-*` 属性，源码里写作 `el.dataset.missing = '1'`（DOM 侧才是 `data-missing`）
  if (!/dataset\.missing\s*=\s*'1'/.test(s.screen)) bad.push('StartScreen.js 没标 dataset.missing');
  if (!/\.start-row\[data-missing='1'\]/.test(s.css)) bad.push('style.css 没有 data-missing 的可见样式');
  if (!/status\.recent-not-found/.test(s.main)) bad.push('main.js 没有把打不开的那句写进状态条');

  // ── INV-START-06：File 菜单那几行（id ＋ 位置 ＋ 分隔线） ──
  // ⚠️ 2026-11-15 收紧：原实现用"命中位置前后 260 字符"找 `position:`，
  //    而条目之间的注释有几百字 ⇒ 它会捞到**上一条**的 `position:`
  //    （实测 `file.open-external-editor` 写 4 也照样绿，真值是 5）。
  //    现在逐块解析 `PlainMenuItem { … }`，id / position / sep 必须出自**同一块**。
  // ⚠️ 2026-11-15（阶段 4）：菜单表里允许用**字符串常量**写 id
  //    （`window.new` 是 `id: WINDOW_NEW_ID`，与 `handle_menu_event` 共用一处定义）。
  //    ⇒ 解析器先把 `const NAME: &str = "value";` 收成一张表，再按名字回查；
  //    ⛔ 别退回"只认字面量"——那会把真实的 `window.new` 行当成不存在（项数也会少一条）。
  const 常量值 = {};
  const 常量反查 = {};
  const 常量Re = /const\s+([A-Z][A-Z0-9_]*)\s*:\s*&str\s*=\s*"([^"]+)";/g;
  let cm;
  while ((cm = 常量Re.exec(s.rust))) {
    常量值[cm[1]] = cm[2];
    常量反查[cm[2]] = cm[1];
  }
  const table = s.rust.slice(s.rust.indexOf('const PLAIN_MENU_ITEMS'));
  const blockOnly = table.slice(0, table.indexOf('];'));
  const items = {};
  const itemRe = /PlainMenuItem\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = itemRe.exec(blockOnly))) {
    const b = m[1];
    const sm = /submenu:\s*"([^"]+)"/.exec(b);
    if (!sm || sm[1] !== 'File') continue;
    const idm = /id:\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))/.exec(b);
    const id = idm ? (idm[1] || 常量值[idm[2]] || '') : '';
    if (!id) continue;
    const pos = /position:\s*(\d+)/.exec(b);
    const sep = /sep:\s*SepSide::(\w+)/.exec(b);
    items[id] = { position: pos ? Number(pos[1]) : NaN, sep: sep ? sep[1] : '' };
  }
  // ⭐ `design/0071` §4.2（阶段 3）：`新建文件…` 插到 0，下面 6 项各 +1。
  // ⚠️ 2026-11-15（`design/0076`）：`保存 · 保存为 HTML · 导出为 PDF` 连成一串
  //    ⇒ 保存由 `After` 改 `None`，后面三项全部顺延两位。
  // ⭐ `design/0071` §5（阶段 4，多窗口）：`新建窗口` 插到 **0**（`SepSide::After`），
  //    下面的既有项**全部 +1**。
  // ⭐ `design/0083` §2.2（2026-11-15，原生窗口标签）：`新建标签页`（`⌘T`）插到 **0**
  //    （`SepSide::None` —— 它与 `新建窗口` 是同一类"造一个窗口形态"的动作，两项连成一串），
  //    `新建窗口` 让到 **1**、下面 9 项**再整体 +1** ⇒ `file.new` 2，其余 3..10。File 组共 11 项。
  //    ⚠️ 在这一轮之前是 `window.new` 0 / `file.new` 1 / 其余 2..9（共 10 项）。
  const rows = [['window.new-tab', 0, 'None'], ['window.new', 1, 'After'],
    ['file.new', 2, 'None'],
    ['file.open', 3, 'None'], ['file.open-file', 4, 'None'],
    ['file.quick-open', 5, 'After'], ['file.save', 6, 'None'],
    ['file.export-html', 7, 'None'], ['file.export-pdf', 8, 'After'],
    ['file.toggle-favorite', 9, 'After'], ['file.open-external-editor', 10, 'After']];
  rows.forEach(function (r) {
    const got = items[r[0]];
    if (!got) { bad.push('PLAIN_MENU_ITEMS 的 File 里没有 ' + r[0]); return; }
    if (got.position !== r[1]) {
      bad.push(r[0] + ' 的 position 是 ' + got.position + '，应为 ' + r[1] +
        '（位置是"前面有几个非分隔线元素"）');
    }
    if (got.sep !== r[2]) bad.push(r[0] + ' 的 sep 是 SepSide::' + got.sep + '，应为 SepSide::' + r[2]);
    if (!new RegExp('id:\\s*"' + r[0].replace('.', '\\.') + '"').test(s.rust)
      && !(常量反查[r[0]] && s.rust.indexOf('id: ' + 常量反查[r[0]]) >= 0)) {
      bad.push('SHORTCUTS 里没有 ' + r[0] + '（菜单项的 id 必须已在表里）');
    }
  });
  if (Object.keys(items).length !== rows.length) {
    bad.push('File 子菜单的项数变了（解析到 ' + Object.keys(items).length + ' 条，期望 ' +
      rows.length + '）：新增/删除项要同批改本判据');
  }
  // ⭐ 菜单块里**不许**出现文案字面量：`menu_label` 从 `SHORTCUTS` 派生（`INV-START-06`）
  const labelHits = blockOnly.split('\n').filter(function (line) {
    return /label|title|"[^"]*[^\x00-\x7F][^"]*"/.test(line) && !/^\s*$/.test(line);
  });
  if (labelHits.length) bad.push('PLAIN_MENU_ITEMS 里出现了文案字面量：\n' + labelHits.join('\n'));

  // ── `open_recent_directory` 的**三处清单**（漏一处 = ACL 静默拒，kb/0007） ──
  if (!/"open_recent_directory"/.test(s.build)) bad.push('build.rs 的 commands(&[…]) 少了 open_recent_directory');
  if (!/"allow-open-recent-directory"/.test(s.cap)) bad.push('capabilities/default.json 少了 allow-open-recent-directory');
  if (!/fs_cmd::open_recent_directory/.test(s.rust)) bad.push('invoke_handler 里没有 fs_cmd::open_recent_directory');

  // ── 第二个入口（侧边栏「上次的目录」）走同一条授权命令 ──
  if (!/onOpenLastDirectory/.test(s.sidebar)) {
    bad.push('Sidebar.js 的「上次的目录」没接 onOpenLastDirectory（它仍会弹系统面板）');
  }
  // ⚠️ `design/0070` §2.4 起 `onOpenRecentDirectory` **从不拒绝**（失败用 `{ok:false}` 回答）
  //    ⇒ 接线多了一层：把结果交给 `reportStartOpen` 报告，否则失败会变成"点了没反应"。
  if (!/onOpenLastDirectory:\s*function[\s\S]{0,400}?onOpenRecentDirectory\(root\)/.test(s.main) ||
      !/onOpenLastDirectory:[\s\S]{0,400}?reportStartOpen\(res\)/.test(s.main)) {
    bad.push('main.js 没把 onOpenRecentDirectory 接给侧边栏（并经 reportStartOpen 报告失败）');
  }

  // ── 脚本顺序（`session.start` 与 `main.js` 的加载期取值） ──
  const atStart = s.html.indexOf('src="services/start.js"');
  const atSession = s.html.indexOf('src="services/session.js"');
  const atScreen = s.html.indexOf('src="components/StartScreen.js"');
  const atMain = s.html.indexOf('src="main.js"');
  const atKeymap = s.html.indexOf('src="services/keymap.js"');
  if (atStart < 0) bad.push('index.html 没有 services/start.js');
  else if (!(atStart < atSession)) bad.push('services/start.js 必须排在 session.js 之前');
  if (atScreen < 0) bad.push('index.html 没有 components/StartScreen.js');
  else {
    if (!(atScreen < atMain)) bad.push('components/StartScreen.js 必须排在 main.js 之前');
    if (!(atKeymap >= 0 && atKeymap < atScreen)) bad.push('components/StartScreen.js 必须排在 keymap.js 之后');
  }

  return bad;
}

test('⭐ 产品源码满足 `design/0038` 的全部结构判据', function () {
  const bad = score(SRC);
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

test('⭐ 三条 i18n 键在**两本**字典里都有（启动页不许出现"键名上屏"）', function () {
  const I = require('../../src/services/i18n.js');
  ['start.recent-title', 'start.last-mark', 'start.row-missing', 'status.recent-not-found']
    .forEach(function (k) {
      ['zh', 'en'].forEach(function (lang) {
        const v = I.DICT[lang][k];
        assert.strictEqual(typeof v, 'string', lang + ' 少了 ' + k);
        assert.ok(v.length > 0, lang + ' 的 ' + k + ' 是空串');
      });
    });
});

// ────────────────────────────────────────────────────────────────
// ③ 变异自测（⚠️ 没有这一步，"全绿"不说明判据真的在看）
// ────────────────────────────────────────────────────────────────

test('⭐ 变异自测：七处写坏各必须让**对应**判据变红', function () {
  assert.deepStrictEqual(score(SRC), [], '基线必须先全绿，否则下面分不清是谁的红');
  const with_ = function (patch) { return Object.assign({}, SRC, patch); };

  // 变异 1：正文挂上来时不摘启动页（`document` 级监听还在）
  const m1 = score(with_({ main: SRC.main.replace('if (startScreen) startScreen.clear();', '') }));
  assert.ok(m1.some(function (x) { return x.indexOf('startScreen.clear()') >= 0; }), m1.join('\n'));

  // 变异 2：放行判据漏掉组合态（中文输入法按数字/回车会误触）
  const m2 = score(with_({ screen: SRC.screen.replace('composing: K.isComposingEvent(e),', '') }));
  assert.ok(m2.some(function (x) { return x.indexOf('composing') >= 0; }), m2.join('\n'));

  // 变异 3：`快速打开…` 的分隔线被挪走（菜单排版变了）
  const m3 = score(with_({ rust: SRC.rust.replace(
    'position: 5,\n        sep: SepSide::After,\n        id: "file.quick-open"',
    'position: 5,\n        sep: SepSide::None,\n        id: "file.quick-open"'
  ) }));
  assert.ok(m3.some(function (x) { return x.indexOf('file.quick-open 的 sep') >= 0; }), m3.join('\n'));

  // 变异 4：capabilities 少一条（ACL 静默拒：点一行毫无反应）
  const m4 = score(with_({ cap: SRC.cap.replace('"allow-open-recent-directory",', '') }));
  assert.ok(m4.some(function (x) { return x.indexOf('allow-open-recent-directory') >= 0; }), m4.join('\n'));

  // 变异 5：启动页在别处又被造了一次（有正文时也会出现）
  const m5 = score(with_({ main: SRC.main + '\nstartScreen.render(doc, []);\n' }));
  assert.ok(m5.some(function (x) { return x.indexOf('startScreen.render') >= 0; }), m5.join('\n'));

  // 变异 6：`⌘O` 面板的 `recent` 取值器被换成一个空数组（面板永远说"没有最近"）
  const m6 = score(with_({ main: SRC.main.replace(
    'recent: function () { return S.state.recent; },',
    'recent: function () { return []; },'
  ) }));
  assert.ok(m6.some(function (x) { return x.indexOf('⌘O 面板') >= 0; }), m6.join('\n'));

  // 变异 7：第三处也去读快照（数目对了也可能偷偷抄第二份"最近"）
  const m7 = score(with_({ main: SRC.main + '\nvar __recent = S.state.recent;\n' }));
  assert.ok(m7.some(function (x) { return x.indexOf('应恰好 2 次') >= 0; }), m7.join('\n'));

  // 变异 8：`file.open-external-editor` 的位置退回 9（与上一条 `收藏` 撞格）。
  // ⚠️ 这正是 2026-11-15 之前那条判据的**假绿**形态：它按"命中处前 260 字符"找
  //    `position:`，会捞到上一条（`file.toggle-favorite` 的 9）⇒ 期望值写 9 也绿。
  const m8 = score(with_({ rust: SRC.rust.replace(
    'position: 10,\n        sep: SepSide::After,\n        id: "file.open-external-editor"',
    'position: 9,\n        sep: SepSide::After,\n        id: "file.open-external-editor"'
  ) }));
  assert.ok(m8.some(function (x) { return x.indexOf('file.open-external-editor 的 position') >= 0; }), m8.join('\n'));
});
