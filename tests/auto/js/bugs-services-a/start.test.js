// 启动页的纯逻辑（`src/services/start.js`, `design/0038` / `0043` / `0045`）。
//
// 从历史缺陷出发，守三族**静默**错误：
//   · `0005` 空会话：启动页就是"没有文档"时的全部界面 —— 行画错、或者把快捷键吞掉，
//     用户看到的就是"某个入口按了没反应"，而状态条一个字都不说；
//   · `0058` `⌘` 组合键：启动页把 `⌘1` 当成"打开第 1 行"会抢走应用的快捷键手势；
//   · `0097` 裸功能键：别的层已经处理过（`defaultPrevented`）或输入法组合中时，
//     启动页再处理一次，键就到不了应用。
// 另外守 `0045` 的两步清空：一次迟疑不能被当成确认。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadInto(win, rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'module', 'require', src)(win, undefined, undefined);
}

const win = {};
loadInto(win, 'src/services/start.js');
const S = win.rmd.start;

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0005（空会话按 Cmd-E 报操作失败）
// 变体：空会话就是启动页；没有历史目录时一行都不画，快捷键仍要穿到应用层。
// ─────────────────────────────────────────────────────────────────────────

test('0005/没有历史目录时启动页一行都不画（与空会话逐字节相同）', () => {
  assert.deepStrictEqual(S.rows([]), []);
  assert.deepStrictEqual(S.rows(null), []);
  assert.deepStrictEqual(S.rows(undefined), []);
  assert.deepStrictEqual(S.rows({}), []);
  assert.deepStrictEqual(S.rows('not-an-array'), []);
});

test('0005/坏行跳过，⛔ 不画一行点下去必被后端拒绝的空白', () => {
  const recent = [
    null,
    undefined,
    7,
    {},
    { root: '' },
    { root: 42 },
    { root: '/r/ok' },
  ];
  assert.deepStrictEqual(S.rows(recent).map((r) => r.root), ['/r/ok']);
});

test('0005/坏行不占显示上限：上限数的是真正画出来的行', () => {
  const recent = [];
  for (let i = 0; i < 5; i++) recent.push({ root: '' });
  for (let i = 0; i < 12; i++) recent.push({ root: '/r/d' + i });
  const out = S.rows(recent);
  assert.strictEqual(out.length, S.MAX_ROWS);
  assert.deepStrictEqual(out[0].root, '/r/d0');
  assert.deepStrictEqual(out[9].root, '/r/d9');
});

test('0005/行序原样保留（排序在后端，前端⛔ 再排一遍）', () => {
  const recent = [{ root: '/r/z' }, { root: '/r/a' }, { root: '/r/m' }];
  assert.deepStrictEqual(S.rows(recent).map((r) => r.name), ['z', 'a', 'm']);
});

test('0005/行字段：root 原串保留，name 是目录名，path 是 ~ 缩写', () => {
  const out = S.rows([{ root: '/Users/example/notes', last_file: '/Users/example/notes/a.md', last: true }]);
  assert.deepStrictEqual(out[0], {
    root: '/Users/example/notes',
    name: 'notes',
    path: '~/notes',
    file: 'a.md',
    last: true,
  });
});

test('0005/last 只认真正的 true，缺省 / 1 / "true" 都不标记', () => {
  const out = S.rows([{ root: '/r/a' }, { root: '/r/b', last: 1 }, { root: '/r/c', last: 'true' }, { root: '/r/d', last: true }]);
  assert.deepStrictEqual(out.map((r) => r.last), [false, false, false, true]);
});

test('0005/last_file 非字符串或为空时那一格不画', () => {
  const out = S.rows([
    { root: '/r/a', last_file: '' },
    { root: '/r/b', last_file: 7 },
    { root: '/r/c', last_file: null },
  ]);
  assert.deepStrictEqual(out.map((r) => r.file), ['', '', '']);
});

test('0005/中文根路径的名字与 ~ 缩写都按原串算', () => {
  const out = S.rows([{ root: '/Users/example/资料/笔记' }]);
  assert.strictEqual(out[0].name, '笔记');
  assert.strictEqual(out[0].path, '~/资料/笔记');
});

test('0005/空会话不会被启动页吞掉 ⌘ 组合键（否则空会话里快捷键没反应）', () => {
  assert.strictEqual(S.guard({
    defaultPrevented: false, modifier: true, composing: false, overlay: false, editable: false,
  }), true);
});

test('0005/空会话也不会吞掉别的层已经处理过的键', () => {
  assert.strictEqual(S.guard({
    defaultPrevented: true, modifier: false, composing: false, overlay: false, editable: false,
  }), true);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0058（Cmd-点击链接不打开）
// 变体：`⌘1`…`⌘9` 属于应用快捷键，⛔ 不当成“打开第 n 行”。
// ─────────────────────────────────────────────────────────────────────────

test('0058/带 ⌘ 的数字键整键放行（modifier=true ⇒ 不处理）', () => {
  for (const key of ['1', '2', '9']) {
    assert.strictEqual(S.digitIndex(key), Number(key) - 1);
    assert.strictEqual(S.guard({
      defaultPrevented: false, modifier: true, composing: false, overlay: false, editable: false,
    }), true, '⌘' + key);
  }
});

test('0058/五种放行是“或”关系：任一条成立就整键放行', () => {
  const base = { defaultPrevented: false, modifier: false, composing: false, overlay: false, editable: false };
  assert.strictEqual(S.guard(base), false);
  for (const k of ['defaultPrevented', 'modifier', 'composing', 'overlay', 'editable']) {
    const s = Object.assign({}, base);
    s[k] = true;
    assert.strictEqual(S.guard(s), true, k);
  }
});

test('0058/参数缺省一律按“成立”处理（宁可少处理一个键）', () => {
  assert.strictEqual(S.guard(undefined), true);
  assert.strictEqual(S.guard(null), true);
  assert.strictEqual(S.guard({}), true);
  assert.strictEqual(S.guard({ defaultPrevented: false }), true);
  assert.strictEqual(S.guard({ defaultPrevented: false, modifier: false, composing: false, overlay: false }), true);
});

test('0058/只有严格 false 才算“不成立”，真值 / 非布尔的假值之外都放行', () => {
  const base = { defaultPrevented: false, modifier: false, composing: false, overlay: false, editable: false };
  assert.strictEqual(S.guard(Object.assign({}, base, { modifier: 1 })), true);
  assert.strictEqual(S.guard(Object.assign({}, base, { overlay: 'no' })), true);
  assert.strictEqual(S.guard(Object.assign({}, base, { editable: null })), true);
});

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0097（裸 F2 在默认媒体键设置下可能到不了应用）
// 变体：输入法组合态 / 可编辑焦点 / 覆盖层里的功能键交给别人。
// ─────────────────────────────────────────────────────────────────────────

test('0097/输入法组合中不处理任何键', () => {
  assert.strictEqual(S.guard({
    defaultPrevented: false, modifier: false, composing: true, overlay: false, editable: false,
  }), true);
});

test('0097/焦点在输入框 / 可编辑区时不抢数字键与功能键', () => {
  assert.strictEqual(S.guard({
    defaultPrevented: false, modifier: false, composing: false, overlay: false, editable: true,
  }), true);
});

test('0097/任一覆盖层开着时启动页不处理键', () => {
  assert.strictEqual(S.guard({
    defaultPrevented: false, modifier: false, composing: false, overlay: true, editable: false,
  }), true);
});

test('0097/数字键只映射 1–9，0 与多字符键不映射', () => {
  assert.strictEqual(S.digitIndex('1'), 0);
  assert.strictEqual(S.digitIndex('5'), 4);
  assert.strictEqual(S.digitIndex('9'), 8);
  assert.strictEqual(S.digitIndex('0'), -1);
  assert.strictEqual(S.digitIndex('10'), -1);
  assert.strictEqual(S.digitIndex('１２'), -1, '全角数字不映射');
});

test('0097/非数字 / 非字符串 / 空串都不映射成行', () => {
  for (const k of ['a', ' ', 'F2', '', null, undefined, 1, {}]) {
    assert.strictEqual(S.digitIndex(k), -1, String(k));
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 显示换算：~ 缩写与名字都只用于显示，⛔ 不据此拼路径
// ─────────────────────────────────────────────────────────────────────────

test('0005/tilde 只缩 /Users/<一段> 前缀，别的路径原样', () => {
  assert.strictEqual(S.tilde('/Users/example'), '~');
  assert.strictEqual(S.tilde('/Users/example/notes/a.md'), '~/notes/a.md');
  assert.strictEqual(S.tilde('/Users/中文/资料'), '~/资料');
  assert.strictEqual(S.tilde('/home/u/x'), '/home/u/x');
  assert.strictEqual(S.tilde('/Users'), '/Users');
  assert.strictEqual(S.tilde('relative/path'), 'relative/path');
});

test('0005/tilde 对非字符串给空串，⛔ 不抛', () => {
  assert.strictEqual(S.tilde(null), '');
  assert.strictEqual(S.tilde(undefined), '');
  assert.strictEqual(S.tilde(7), '');
});

test('0005/basename 先剥尾部斜杠，根回落成 /', () => {
  assert.strictEqual(S.basename('/a/b/'), 'b');
  assert.strictEqual(S.basename('/a//b'), 'b');
  assert.strictEqual(S.basename('/a//'), 'a');
  assert.strictEqual(S.basename('/'), '/');
  assert.strictEqual(S.basename('///'), '/');
  assert.strictEqual(S.basename('a/b'), 'b');
  assert.strictEqual(S.basename('abc'), 'abc');
});

test('0005/basename 对空串与非字符串给空串', () => {
  assert.strictEqual(S.basename(''), '');
  assert.strictEqual(S.basename(null), '');
  assert.strictEqual(S.basename(42), '');
});

test('0005/中文目录名与隐藏目录名都照原样取最后一段', () => {
  assert.strictEqual(S.basename('/资料/笔记/'), '笔记');
  assert.strictEqual(S.basename('/r/.hidden'), '.hidden');
  assert.strictEqual(S.basename('/r/a.b.md'), 'a.b.md');
});

// ─────────────────────────────────────────────────────────────────────────
// 收藏段：顺序是用户排的，前端⛔ 不排序、不截断、不过滤存在性
// ─────────────────────────────────────────────────────────────────────────

test('0005/收藏不是数组时一段都不画', () => {
  assert.deepStrictEqual(S.favoriteRows(null), []);
  assert.deepStrictEqual(S.favoriteRows(undefined), []);
  assert.deepStrictEqual(S.favoriteRows({}), []);
});

test('0005/收藏行字段：path 原串、name 最后一段、tilded 缩写', () => {
  assert.deepStrictEqual(S.favoriteRows(['/Users/example/notes/a.md']), [
    { path: '/Users/example/notes/a.md', name: 'a.md', tilded: '~/notes/a.md' },
  ]);
});

test('0005/收藏顺序与重复项原样保留（用户可能故意排两次）', () => {
  const out = S.favoriteRows(['/b.md', '/a.md', '/b.md']);
  assert.deepStrictEqual(out.map((r) => r.path), ['/b.md', '/a.md', '/b.md']);
});

test('0005/收藏不截断到 10 行（那是“最近目录”的上限）', () => {
  const many = [];
  for (let i = 0; i < 15; i++) many.push('/r/f' + i + '.md');
  assert.strictEqual(S.favoriteRows(many).length, 15);
});

test('0005/收藏坏行跳过，⛔ 不画空白行', () => {
  assert.deepStrictEqual(S.favoriteRows(['', null, 7, {}, '/r/ok.md']).map((r) => r.path), ['/r/ok.md']);
});

// ─────────────────────────────────────────────────────────────────────────
// 两步清空（design/0045）：迟疑不能被当成确认
// ─────────────────────────────────────────────────────────────────────────

test('0045/常量就是设计拍板的 10 行与 3 秒', () => {
  assert.strictEqual(S.MAX_ROWS, 10);
  assert.strictEqual(S.CLEAR_CONFIRM_MS, 3000);
});

test('0045/第一次点只进入确认态，不执行清空', () => {
  assert.deepStrictEqual(S.clearConfirm(0, 1000), { fire: false, nextArmedAt: 1000 });
});

test('0045/窗口内再点一次才真的清空，并复位确认态', () => {
  assert.deepStrictEqual(S.clearConfirm(1000, 1000), { fire: true, nextArmedAt: 0 });
  assert.deepStrictEqual(S.clearConfirm(1000, 2500), { fire: true, nextArmedAt: 0 });
  assert.deepStrictEqual(S.clearConfirm(1000, 4000), { fire: true, nextArmedAt: 0 }, '恰好 3000 ms 仍算窗口内');
});

test('0045/超出窗口后的那一下当成新的第一下', () => {
  assert.deepStrictEqual(S.clearConfirm(1000, 4001), { fire: false, nextArmedAt: 4001 });
  assert.deepStrictEqual(S.clearConfirm(1000, 99999), { fire: false, nextArmedAt: 99999 });
});

test('0045/时钟倒退当成新的第一下，⛔ 不把一次迟疑算成确认', () => {
  assert.deepStrictEqual(S.clearConfirm(5000, 4000), { fire: false, nextArmedAt: 4000 });
});

test('0045/确认态值非法时按“没有待确认”处理', () => {
  assert.deepStrictEqual(S.clearConfirm(-1, 10), { fire: false, nextArmedAt: 10 });
  assert.deepStrictEqual(S.clearConfirm('1000', 2000), { fire: false, nextArmedAt: 2000 });
  assert.deepStrictEqual(S.clearConfirm(null, 2000), { fire: false, nextArmedAt: 2000 });
  assert.deepStrictEqual(S.clearConfirm(NaN, 2000), { fire: false, nextArmedAt: 2000 });
});
