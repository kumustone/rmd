// 文档内链接纯逻辑（`src/services/links.js`）的补充用例。
//
// 这张“后端结果 → 界面动作”的映射表漏一格，表现是“点了没反应”，
// 而它⛔ 不报错。这里逐格断言，并钉住“前端不二次解码 / 不拼路径”的边界。
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
loadInto(win, 'src/services/links.js');
const L = win.rmd.links;

// ─────────────────────────────────────────────────────────────────────────
// href 归一与片段解码
// ─────────────────────────────────────────────────────────────────────────

test('normalizeHref：只 trim，中间一个字符都不动', () => {
  assert.strictEqual(L.normalizeHref('  /a b  '), '/a b');
  assert.strictEqual(L.normalizeHref('\n\t/a\t\n'), '/a');
  assert.strictEqual(L.normalizeHref('a%20b'), 'a%20b', '⛔ 前端不解码');
});

test('normalizeHref：非字符串返回空串，⛔ 不 String() 出 "undefined"', () => {
  assert.strictEqual(L.normalizeHref(null), '');
  assert.strictEqual(L.normalizeHref(undefined), '');
  assert.strictEqual(L.normalizeHref(7), '');
  assert.strictEqual(L.normalizeHref({}), '');
});

test('decodeFragment：解一次，认不认 # 都行', () => {
  assert.strictEqual(L.decodeFragment('#a%20b'), 'a b');
  assert.strictEqual(L.decodeFragment('a%20b'), 'a b');
  assert.strictEqual(L.decodeFragment('#%E4%B8%AD'), '中');
  assert.strictEqual(L.decodeFragment('##a'), '#a', '只剥第一个 #');
});

test('decodeFragment：非法百分号序列原样保留，⛔ 不让它抛', () => {
  assert.strictEqual(L.decodeFragment('%'), '%');
  assert.strictEqual(L.decodeFragment('%E4'), '%E4');
  assert.strictEqual(L.decodeFragment('a%ZZb'), 'a%ZZb');
  assert.strictEqual(L.decodeFragment(null), '');
});

// ─────────────────────────────────────────────────────────────────────────
// anchorFor
// ─────────────────────────────────────────────────────────────────────────

test('anchorFor：只用 getElementById，含 : / . 的 ID 不许抛', () => {
  const asked = [];
  const docEl = {
    getElementById: function (id) { asked.push(id); return id === 'a:b.c' ? { id: id } : null; },
  };
  assert.deepStrictEqual(L.anchorFor('a:b.c', docEl), { id: 'a:b.c' });
  assert.deepStrictEqual(asked, ['a:b.c']);
});

test('anchorFor：空片段 / 没有容器 / 查不到 ⇒ null（调用方必须说话）', () => {
  const docEl = { getElementById: function () { return null; } };
  assert.strictEqual(L.anchorFor('', docEl), null);
  assert.strictEqual(L.anchorFor(null, docEl), null);
  assert.strictEqual(L.anchorFor(7, docEl), null);
  assert.strictEqual(L.anchorFor('x', null), null);
  assert.strictEqual(L.anchorFor('x', {}), null);
  assert.strictEqual(L.anchorFor('x', docEl), null);
});

// ─────────────────────────────────────────────────────────────────────────
// plan：结果 → 动作
// ─────────────────────────────────────────────────────────────────────────

test('plan：成功类 kind 各自映射到正确的动作', () => {
  assert.deepStrictEqual(L.plan({ kind: 'empty' }), {
    action: 'status', key: 'link.empty', isError: true,
  });
  assert.deepStrictEqual(L.plan({ kind: 'anchor', fragment: 'f' }), {
    action: 'anchor', fragment: 'f',
  });
  assert.deepStrictEqual(L.plan({ kind: 'document', path: '/p', fragment: 'f' }), {
    action: 'open', path: '/p', fragment: 'f',
  });
  assert.deepStrictEqual(L.plan({ kind: 'reveal' }), {
    action: 'status', key: 'link.revealed',
  });
  assert.deepStrictEqual(L.plan({ kind: 'external' }), {
    action: 'status', key: 'link.external-opened',
  });
  assert.deepStrictEqual(L.plan({ kind: 'stale' }), {
    action: 'status', key: 'link.stale',
  });
});

test('plan：path / fragment 缺字段时给空串，⛔ 不猜', () => {
  assert.deepStrictEqual(L.plan({ kind: 'document' }), {
    action: 'open', path: '', fragment: '',
  });
  assert.deepStrictEqual(L.plan({ kind: 'anchor' }), {
    action: 'anchor', fragment: '',
  });
});

test('plan：失败类 kind 都把后端 message 原样带进文案', () => {
  assert.deepStrictEqual(L.plan({ kind: 'reveal_failed', message: 'm1' }), {
    action: 'status', key: 'link.reveal-failed', vars: { message: 'm1' }, isError: true,
  });
  assert.deepStrictEqual(L.plan({ kind: 'external_failed', message: 'm2' }), {
    action: 'status', key: 'link.external-failed', vars: { message: 'm2' }, isError: true,
  });
  assert.deepStrictEqual(L.plan({ kind: 'failed', message: 'm3' }), {
    action: 'status', key: 'link.failed', vars: { message: 'm3' }, isError: true,
  });
});

test('plan：unauthorized 走“问授权”，missing 只是错误提示，两者不合并', () => {
  assert.deepStrictEqual(L.plan({ kind: 'unauthorized', href: '/x' }), {
    action: 'ask-auth', key: 'link.unauthorized', vars: { href: '/x' },
  });
  assert.deepStrictEqual(L.plan({ kind: 'missing', href: '/x' }), {
    action: 'status', key: 'link.missing', vars: { href: '/x' }, isError: true,
  });
});

test('plan：unsupported 带 scheme，缺省用 ? 而不是空洞', () => {
  assert.deepStrictEqual(L.plan({ kind: 'unsupported', message: 'ftp' }), {
    action: 'status', key: 'link.unsupported', vars: { scheme: 'ftp' }, isError: true,
  });
  assert.deepStrictEqual(L.plan({ kind: 'unsupported' }), {
    action: 'status', key: 'link.unsupported', vars: { scheme: '?' }, isError: true,
  });
});

test('plan：local_query 与 no_document 各有各的说明', () => {
  assert.deepStrictEqual(L.plan({ kind: 'local_query', href: '/x?y' }), {
    action: 'status', key: 'link.local-query', vars: { href: '/x?y' }, isError: true,
  });
  assert.deepStrictEqual(L.plan({ kind: 'no_document' }), {
    action: 'status', key: 'link.no-document', isError: true,
  });
});

test('plan：未知 / 空的回包仍然说一句话（⛔ 点了没反应）', () => {
  assert.deepStrictEqual(L.plan({ kind: 'brand_new' }), {
    action: 'status', key: 'link.failed', vars: { message: 'brand_new' }, isError: true,
  });
  assert.deepStrictEqual(L.plan(null), {
    action: 'status', key: 'link.failed', vars: { message: '' }, isError: true,
  });
  assert.deepStrictEqual(L.plan('x'), {
    action: 'status', key: 'link.failed', vars: { message: '' }, isError: true,
  });
});

test('KINDS 是封闭清单：无重复，且每一格都有专门映射', () => {
  assert.strictEqual(L.KINDS.length, 14);
  assert.strictEqual(new Set(L.KINDS).size, 14, 'KINDS 里有重复项');
  for (const kind of L.KINDS) {
    const p = L.plan({ kind: kind });
    assert.ok(p && typeof p.action === 'string', kind + ' 没有动作');
    // failed 本来就映射到 link.failed；其余 kind 不许落进兜底那一格。
    if (kind !== 'failed') {
      assert.notStrictEqual(p.key, 'link.failed', kind + ' 落进了未知 kind 的兜底');
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// isAlive
// ─────────────────────────────────────────────────────────────────────────

test('isAlive：按会话号严格相等，⛔ 宽松比较、⛔ 认时间', () => {
  assert.strictEqual(L.isAlive(3, 3), true);
  assert.strictEqual(L.isAlive(3, 4), false);
  assert.strictEqual(L.isAlive('3', 3), false);
  assert.strictEqual(L.isAlive(null, undefined), false);
  assert.strictEqual(L.isAlive(undefined, undefined), true);
});
