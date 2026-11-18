// 启动页纯逻辑（`src/services/start.js`）的补充用例。
//
// 排序 / 截断 / `last` 标记都在后端；本文件只做展示换算与键盘判据。
// 这里钉的是“展示换算不许反推成路径”、“缺省一律放行”这两条口径。
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
// 展示换算
// ─────────────────────────────────────────────────────────────────────────

test('tilde：只缩 /Users/<用户> 前缀，其余路径原样', () => {
  assert.strictEqual(S.tilde('/Users/example/work'), '~/work');
  assert.strictEqual(S.tilde('/Users/example'), '~');
  assert.strictEqual(S.tilde('/home/x'), '/home/x');
  assert.strictEqual(S.tilde('/Users'), '/Users');
  assert.strictEqual(S.tilde(''), '');
  assert.strictEqual(S.tilde(null), '');
});

test('basename：剥掉尾部分隔符，根回落成 /', () => {
  assert.strictEqual(S.basename('/a/b/'), 'b');
  assert.strictEqual(S.basename('/a/b'), 'b');
  assert.strictEqual(S.basename('abc'), 'abc');
  assert.strictEqual(S.basename('/'), '/');
  assert.strictEqual(S.basename('///'), '/');
  assert.strictEqual(S.basename(''), '');
  assert.strictEqual(S.basename(null), '');
});

test('rows：后端顺序原样保留，不排序', () => {
  const out = S.rows([
    { root: '/z', last: false },
    { root: '/a', last: true },
  ]);
  assert.deepStrictEqual(out.map((r) => r.root), ['/z', '/a']);
});

test('rows：root 原串保留，name / path 只用于显示', () => {
  const out = S.rows([{ root: '/Users/example/notes', last_file: '/Users/example/notes/a.md' }]);
  assert.deepStrictEqual(out[0], {
    root: '/Users/example/notes',
    name: 'notes',
    path: '~/notes',
    file: 'a.md',
    last: false,
  });
});

test('rows：last 只在严格等于 true 时为真', () => {
  assert.strictEqual(S.rows([{ root: '/a', last: true }])[0].last, true);
  assert.strictEqual(S.rows([{ root: '/a', last: 1 }])[0].last, false);
  assert.strictEqual(S.rows([{ root: '/a', last: 'true' }])[0].last, false);
  assert.strictEqual(S.rows([{ root: '/a' }])[0].last, false);
});

test('rows：last_file 非字符串 ⇒ 空串（界面那一格不画）', () => {
  assert.strictEqual(S.rows([{ root: '/a' }])[0].file, '');
  assert.strictEqual(S.rows([{ root: '/a', last_file: 7 }])[0].file, '');
  assert.strictEqual(S.rows([{ root: '/a', last_file: '/x/y/b.md' }])[0].file, 'b.md');
});

test('rows：坏行跳过、非数组退回空、最多 10 行', () => {
  assert.deepStrictEqual(S.rows(null), []);
  assert.deepStrictEqual(S.rows('x'), []);
  assert.deepStrictEqual(S.rows([null, {}, { root: '' }, { root: 7 }]), []);
  const many = [];
  for (let i = 0; i < 30; i++) many.push({ root: '/d' + i });
  const out = S.rows(many);
  assert.strictEqual(out.length, 10);
  assert.strictEqual(out[0].root, '/d0');
  assert.strictEqual(out[9].root, '/d9');
});

test('favoriteRows：原串回传、顺序原样、不截断', () => {
  const many = [];
  for (let i = 0; i < 15; i++) many.push('/Users/example/f' + i + '.md');
  const out = S.favoriteRows(many);
  assert.strictEqual(out.length, 15);
  assert.deepStrictEqual(out[0], {
    path: '/Users/example/f0.md', name: 'f0.md', tilded: '~/f0.md',
  });
  assert.deepStrictEqual(out.map((r) => r.path), many);
});

test('favoriteRows：坏行跳过、非数组退回空', () => {
  assert.deepStrictEqual(S.favoriteRows(null), []);
  assert.deepStrictEqual(S.favoriteRows('x'), []);
  assert.deepStrictEqual(S.favoriteRows([null, '', 7, '/a/b.md']), [
    { path: '/a/b.md', name: 'b.md', tilded: '/a/b.md' },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// ⭐ `bugs/0301`：点收藏之后的动作只看 `opened_favorite`（⛔ 不看 `mode`）
// ─────────────────────────────────────────────────────────────────────────

test('favoriteOpenAction：目录收藏 ⇒ directory', () => {
  assert.deepStrictEqual(
    S.favoriteOpenAction({ mode: 'directory', opened_favorite: 'directory', startup_document: null }),
    { kind: 'directory', path: '' },
  );
});

test('favoriteOpenAction：⭐ 已开着目录时点文件收藏，mode 仍是 directory，仍须走 file', () => {
  // 这就是缺陷态的形状：`Session::mode()` 判 roots 优先 ⇒ `mode === 'directory'`。
  // 照 `mode` 分派会走空态分支，`startup_document` 被丢掉（"点了没反应"）。
  const snap = {
    mode: 'directory',
    opened_favorite: 'file',
    startup_document: '/Users/example/notes/a.md',
  };
  assert.deepStrictEqual(S.favoriteOpenAction(snap), {
    kind: 'file',
    path: '/Users/example/notes/a.md',
  });
});

test('favoriteOpenAction：空会话下的文件收藏（mode=single-file）同样走 file', () => {
  const snap = {
    mode: 'single-file',
    opened_favorite: 'file',
    startup_document: '/x/a.md',
  };
  assert.deepStrictEqual(S.favoriteOpenAction(snap), { kind: 'file', path: '/x/a.md' });
});

test('favoriteOpenAction：缺 `opened_favorite` ⇒ unknown，⛔ 不从 mode 猜', () => {
  assert.deepStrictEqual(
    S.favoriteOpenAction({ mode: 'single-file', startup_document: '/x/a.md' }),
    { kind: 'unknown', path: '' },
  );
  assert.deepStrictEqual(
    S.favoriteOpenAction({ mode: 'directory', startup_document: null }),
    { kind: 'unknown', path: '' },
  );
  assert.deepStrictEqual(S.favoriteOpenAction({ opened_favorite: 'file' }), { kind: 'file', path: '' });
});

test('favoriteOpenAction：坏输入 / 坏取值一律 unknown', () => {
  assert.deepStrictEqual(S.favoriteOpenAction(null), { kind: 'unknown', path: '' });
  assert.deepStrictEqual(S.favoriteOpenAction(undefined), { kind: 'unknown', path: '' });
  assert.deepStrictEqual(S.favoriteOpenAction('x'), { kind: 'unknown', path: '' });
  assert.deepStrictEqual(
    S.favoriteOpenAction({ opened_favorite: 'file', startup_document: 7 }),
    { kind: 'file', path: '' },
  );
  assert.deepStrictEqual(S.favoriteOpenAction({ opened_favorite: 'weird' }), { kind: 'unknown', path: '' });
});

// ─────────────────────────────────────────────────────────────────────────
// 清空最近目录：两步确认
// ─────────────────────────────────────────────────────────────────────────

test('clearConfirm：第一下只上膛，不清空', () => {
  assert.deepStrictEqual(S.clearConfirm(0, 1000), { fire: false, nextArmedAt: 1000 });
});

test('clearConfirm：窗口内第二下才真清空，并复位', () => {
  assert.deepStrictEqual(S.clearConfirm(1000, 2000), { fire: true, nextArmedAt: 0 });
  // 恰好 3000 ms 仍在窗口内（<=）
  assert.deepStrictEqual(S.clearConfirm(1000, 4000), { fire: true, nextArmedAt: 0 });
});

test('clearConfirm：超出窗口 / 时钟倒退 ⇒ 当成新的第一下', () => {
  assert.deepStrictEqual(S.clearConfirm(1000, 4001), { fire: false, nextArmedAt: 4001 });
  assert.deepStrictEqual(S.clearConfirm(1000, 999), { fire: false, nextArmedAt: 999 });
});

test('clearConfirm：非法的“已上膛”值一律回到第一下', () => {
  assert.deepStrictEqual(S.clearConfirm(-1, 500), { fire: false, nextArmedAt: 500 });
  assert.deepStrictEqual(S.clearConfirm('x', 500), { fire: false, nextArmedAt: 500 });
  assert.deepStrictEqual(S.clearConfirm(null, 500), { fire: false, nextArmedAt: 500 });
});

test('clearConfirm：两个常量就是设计里定的数', () => {
  assert.strictEqual(S.CLEAR_CONFIRM_MS, 3000);
  assert.strictEqual(S.MAX_ROWS, 10);
});

// ─────────────────────────────────────────────────────────────────────────
// 数字键与键盘放行
// ─────────────────────────────────────────────────────────────────────────

test('digitIndex：只认单字符 1–9', () => {
  assert.strictEqual(S.digitIndex('1'), 0);
  assert.strictEqual(S.digitIndex('9'), 8);
  assert.strictEqual(S.digitIndex('0'), -1);
  assert.strictEqual(S.digitIndex('10'), -1);
  assert.strictEqual(S.digitIndex(''), -1);
  assert.strictEqual(S.digitIndex('a'), -1);
  assert.strictEqual(S.digitIndex(null), -1);
  // 全角数字不是 Digit1 的 key
  assert.strictEqual(S.digitIndex('１'), -1);
});

test('guard：五项全为 false 时才由启动页处理', () => {
  assert.strictEqual(S.guard({
    defaultPrevented: false,
    modifier: false,
    composing: false,
    overlay: false,
    editable: false,
  }), false);
});

test('guard：五项任一成立就整键放行', () => {
  const base = {
    defaultPrevented: false,
    modifier: false,
    composing: false,
    overlay: false,
    editable: false,
  };
  for (const k of Object.keys(base)) {
    const s = Object.assign({}, base);
    s[k] = true;
    assert.strictEqual(S.guard(s), true, k + ' 成立时没有放行');
  }
});

test('guard：缺省 / 非布尔一律按“成立”放行（宁可少处理一个键）', () => {
  assert.strictEqual(S.guard({}), true);
  assert.strictEqual(S.guard(null), true);
  assert.strictEqual(S.guard(undefined), true);
  assert.strictEqual(S.guard({ defaultPrevented: 0, modifier: 0, composing: 0, overlay: 0, editable: 0 }), true);
  assert.strictEqual(S.guard({ defaultPrevented: 0 }), true);
});
