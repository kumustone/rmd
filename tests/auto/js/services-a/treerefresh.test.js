// 文件树刷新/新建/复制路径/重命名纯逻辑（`src/services/treerefresh.js`）的补充用例。
//
// 这些判据错一个的表现都在**某个时刻**才出现：外部新增永远不出现、
// 右键空白处 TypeError、改名后高亮挂到另一份文档上——都⛔ 不报错。
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
loadInto(win, 'src/services/i18n.js');
loadInto(win, 'src/services/treerefresh.js');
const T = win.rmd.treeRefresh;

// ─────────────────────────────────────────────────────────────────────────
// 层 epoch、请求序、路径工具
// ─────────────────────────────────────────────────────────────────────────

test('staleLayer：没记过也算旧，epoch 不同算旧', () => {
  const m = new Map();
  assert.strictEqual(T.staleLayer(m, '/a', 1), true);
  m.set('/a', 1);
  assert.strictEqual(T.staleLayer(m, '/a', 1), false);
  assert.strictEqual(T.staleLayer(m, '/a', 2), true);
});

test('nextSeq：按路径各自从 1 开始，互不干扰', () => {
  const m = new Map();
  assert.strictEqual(T.nextSeq(m, '/a'), 1);
  assert.strictEqual(T.nextSeq(m, '/a'), 2);
  assert.strictEqual(T.nextSeq(m, '/b'), 1);
  assert.strictEqual(T.nextSeq(m, '/a'), 3);
});

test('isCurrent：只有该路径最新的请求号才算数', () => {
  const m = new Map([['/a', 2]]);
  assert.strictEqual(T.isCurrent(m, '/a', 2), true);
  assert.strictEqual(T.isCurrent(m, '/a', 1), false);
  assert.strictEqual(T.isCurrent(m, '/b', 1), false);
});

test('depthOf：按非空段计数', () => {
  assert.strictEqual(T.depthOf(''), 0);
  assert.strictEqual(T.depthOf('/'), 0);
  assert.strictEqual(T.depthOf('/a/b'), 2);
  assert.strictEqual(T.depthOf('a/b'), 2);
  assert.strictEqual(T.depthOf('//a'), 1);
  assert.strictEqual(T.depthOf(7), 1);
});

test('sortShallowFirst：祖先一定在后代之前，同深度按字面序', () => {
  assert.deepStrictEqual(
    T.sortShallowFirst(['/a/b/c', '/b', '/a/b', '/a']),
    ['/a', '/b', '/a/b', '/a/b/c']
  );
});

test('parentOf：根下的 /abc 父是 /，没有斜杠时是空串', () => {
  assert.strictEqual(T.parentOf('abc'), '');
  assert.strictEqual(T.parentOf('/abc'), '/');
  assert.strictEqual(T.parentOf('/a/b'), '/a');
  assert.strictEqual(T.parentOf('/a/'), '/a');
  assert.strictEqual(T.parentOf(''), '');
});

test('descendants：只看 path 之下的，前缀陷阱不算，结果浅→深', () => {
  const expanded = new Set(['/a', '/ab', '/a/x', '/a/x/y', '/b']);
  assert.deepStrictEqual(T.descendants(expanded, '/a'), ['/a/x', '/a/x/y']);
});

test('descendants：path 带尾斜杠与不带等价', () => {
  assert.deepStrictEqual(T.descendants(new Set(['/a/x']), '/a/'), ['/a/x']);
});

// ─────────────────────────────────────────────────────────────────────────
// 滚动锚点
// ─────────────────────────────────────────────────────────────────────────

test('anchorRow：取第一个底边越过容器顶边的行，offset 可为负', () => {
  const rows = [
    { path: '/a', top: 0, bottom: 10 },
    { path: '/b', top: 10, bottom: 30 },
  ];
  assert.deepStrictEqual(T.anchorRow(rows, 20), { path: '/b', offset: -10 });
  assert.deepStrictEqual(T.anchorRow(rows, 0), { path: '/a', offset: 0 });
});

test('anchorRow：没有行越过顶边 / 空列表 ⇒ null', () => {
  assert.strictEqual(T.anchorRow([{ path: '/a', top: 0, bottom: 20 }], 20), null);
  assert.strictEqual(T.anchorRow([], 0), null);
});

test('restoreOffset：锚点行还在新树里', () => {
  const anchor = { path: '/a', offset: 5 };
  const rows = [{ path: '/a', top: 105 }];
  assert.strictEqual(T.restoreOffset(anchor, rows, 100), 0);
});

test('restoreOffset：锚点行没了就退到最近的存活祖先', () => {
  const anchor = { path: '/a/b/c', offset: 10 };
  const rows = [{ path: '/a', top: 100 }];
  assert.strictEqual(T.restoreOffset(anchor, rows, 50), 40);
});

test('restoreOffset：祖先也不在 ⇒ null（调用方只夹取，⛔ 不回顶部）', () => {
  assert.strictEqual(T.restoreOffset({ path: '/x/y', offset: 0 }, [], 0), null);
  assert.strictEqual(T.restoreOffset(null, [], 0), null);
});

test('restoreOffset：parentOf 原地打转时不会死循环', () => {
  const rows = [];
  const out = T.restoreOffset(
    { path: '/a/b', offset: 0 }, rows, 0, function (p) { return p; }
  );
  assert.strictEqual(out, null);
});

// ─────────────────────────────────────────────────────────────────────────
// decide：刷新事务的四个身份
// ─────────────────────────────────────────────────────────────────────────

function decideCase(over) {
  return T.decide(Object.assign({
    gen0: 1, gen: 1, token0: 1, token: 1, version0: 1, version: 1,
    seq0: 1, seq: 1, retries: 0,
  }, over || {}));
}

test('decide：token 变了 ⇒ 整棵树换了，直接丢弃且不重跑', () => {
  assert.deepStrictEqual(decideCase({ token: 2 }), {
    action: 'discard', reason: 'cancelled', retry: false, delayMs: 0,
  });
});

test('decide：gen 变了 ⇒ 这一轮已作废，丢弃且不重跑', () => {
  assert.deepStrictEqual(decideCase({ gen: 2 }), {
    action: 'discard', reason: 'stale', retry: false, delayMs: 0,
  });
});

test('decide：盘上内容变了（seq）⇒ 必须重跑，等 1 s 避让事件簇', () => {
  assert.deepStrictEqual(decideCase({ seq: 2 }), {
    action: 'discard', reason: 'rev', retry: true, delayMs: T.RETRY_DELAY_MS,
  });
});

test('decide：rev 重试次数用尽 ⇒ give_up，等下一次事件', () => {
  assert.deepStrictEqual(decideCase({ seq: 2, retries: T.MAX_RETRIES }), {
    action: 'give_up', reason: 'rev', retry: false, delayMs: 0,
  });
});

test('decide：用户动了树 ⇒ 第一次立即重跑，第二次隔 1 s，再打断就放弃', () => {
  assert.deepStrictEqual(decideCase({ version: 2 }), {
    action: 'discard', reason: 'user', retry: true, delayMs: 0,
  });
  assert.deepStrictEqual(decideCase({ version: 2, retries: 1 }), {
    action: 'discard', reason: 'user', retry: true, delayMs: 1000,
  });
  assert.deepStrictEqual(decideCase({ version: 2, retries: 2 }), {
    action: 'give_up', reason: 'user', retry: false, delayMs: 0,
  });
});

test('decide：seq 缺失（老调用点）当“没观测”，⛔ 不当成变了', () => {
  assert.strictEqual(decideCase({ seq: undefined, seq0: undefined }).action, 'commit');
  assert.strictEqual(decideCase({ seq: 9, seq0: undefined }).action, 'commit');
  assert.strictEqual(decideCase({ seq: undefined, seq0: 1 }).action, 'commit');
});

test('decide：四个身份都没变 ⇒ commit', () => {
  assert.deepStrictEqual(decideCase(), {
    action: 'commit', reason: 'ok', retry: false, delayMs: 0,
  });
});

test('decide：优先级 token > gen > seq > version', () => {
  // 多个都变了时先撞 token
  assert.strictEqual(decideCase({ token: 2, gen: 2, seq: 2, version: 2 }).reason, 'cancelled');
  assert.strictEqual(decideCase({ gen: 2, seq: 2, version: 2 }).reason, 'stale');
  assert.strictEqual(decideCase({ seq: 2, version: 2 }).reason, 'rev');
});

// ─────────────────────────────────────────────────────────────────────────
// 挂起 / 置灰
// ─────────────────────────────────────────────────────────────────────────

test('shouldDefer：输入行开着 / 创建在飞 / 事务在跑任一成立就挂起', () => {
  assert.strictEqual(T.shouldDefer({ inputOpen: true }), true);
  assert.strictEqual(T.shouldDefer({ creating: true }), true);
  assert.strictEqual(T.shouldDefer({ running: true }), true);
  assert.strictEqual(T.shouldDefer({}), false);
  assert.strictEqual(T.shouldDefer(null), false);
  assert.strictEqual(T.shouldDefer(undefined), false);
});

test('manualDisabled：事务在跑不置灰，只挡输入行与创建中', () => {
  assert.strictEqual(T.manualDisabled({ inputOpen: true }), true);
  assert.strictEqual(T.manualDisabled({ creating: true }), true);
  assert.strictEqual(T.manualDisabled({ running: true }), false);
  assert.strictEqual(T.manualDisabled({}), false);
  assert.strictEqual(T.manualDisabled(null), false);
});

// ─────────────────────────────────────────────────────────────────────────
// 右键目标
// ─────────────────────────────────────────────────────────────────────────

test('resolveMenuTarget：没有根 / 灰显行 ⇒ 不出菜单', () => {
  assert.strictEqual(T.resolveMenuTarget({ path: '/r/a.md', isDir: false }, null), null);
  assert.strictEqual(
    T.resolveMenuTarget({ path: '/r/node_modules', isDir: true, ignored: true }, '/r'),
    null
  );
});

test('resolveMenuTarget：空白处落在根，目录行落在自己，文件行落在父目录', () => {
  assert.deepStrictEqual(T.resolveMenuTarget(null, '/r'), { dir: '/r', kind: 'blank' });
  assert.deepStrictEqual(
    T.resolveMenuTarget({ path: '/r/x', isDir: true }, '/r'),
    { dir: '/r/x', kind: 'dir' }
  );
  assert.deepStrictEqual(
    T.resolveMenuTarget({ path: '/r/x/a.md', isDir: false }, '/r'),
    { dir: '/r/x', kind: 'file' }
  );
});

test('resolveMenuTarget：root 直接的文件的父目录回落到 root', () => {
  // 节点路径来自后端；这里只切最后一段，父目录为空时用 root。
  assert.deepStrictEqual(
    T.resolveMenuTarget({ path: 'a.md', isDir: false }, '/r'),
    { dir: '/r', kind: 'file' }
  );
});

test('copyTarget：路径原样返回，⛔ 不 trim / 转义；空白处与灰显不出项', () => {
  assert.strictEqual(T.copyTarget({ path: '/r/a b.md ', isDir: false }, '/r'), '/r/a b.md ');
  assert.strictEqual(T.copyTarget({ path: '/r/x', isDir: true }, '/r'), '/r/x');
  assert.strictEqual(T.copyTarget(null, '/r'), null);
  assert.strictEqual(T.copyTarget({ path: '/r/x', ignored: true }, '/r'), null);
  assert.strictEqual(T.copyTarget({ path: '' }, '/r'), null);
  assert.strictEqual(T.copyTarget({ path: '/r/a' }, null), null);
});

test('renameTarget：只有文件行有这一项，目录 / 空白 / 灰显都没有', () => {
  assert.strictEqual(T.renameTarget({ path: '/r/x', isDir: true }, '/r'), null);
  assert.strictEqual(T.renameTarget(null, '/r'), null);
  assert.strictEqual(T.renameTarget({ path: '/r/x', ignored: true }, '/r'), null);
  assert.strictEqual(T.renameTarget({ path: '' }, '/r'), null);
  assert.strictEqual(T.renameTarget({ path: '/r/a.md' }, null), null);
});

test('renameTarget：编辑态只挡当前文档，别的文件照常可改', () => {
  assert.deepStrictEqual(
    T.renameTarget({ path: '/r/a.md', isDir: false }, '/r', { editing: true, current: '/r/a.md' }),
    { path: '/r/a.md', disabled: true, reason: 'editing' }
  );
  assert.deepStrictEqual(
    T.renameTarget({ path: '/r/b.md', isDir: false }, '/r', { editing: true, current: '/r/a.md' }),
    { path: '/r/b.md', disabled: false }
  );
  assert.deepStrictEqual(
    T.renameTarget({ path: '/r/a.md', isDir: false }, '/r'),
    { path: '/r/a.md', disabled: false }
  );
});

test('revealTarget：文件与目录都有，isDir 只当提示且严格取 true', () => {
  assert.deepStrictEqual(
    T.revealTarget({ path: '/r/a.md', isDir: false }, '/r'),
    { path: '/r/a.md', isDir: false }
  );
  assert.deepStrictEqual(
    T.revealTarget({ path: '/r/x', isDir: true }, '/r'),
    { path: '/r/x', isDir: true }
  );
  // 非 true 的真值不许冒充目录
  assert.deepStrictEqual(
    T.revealTarget({ path: '/r/x', isDir: 'yes' }, '/r'),
    { path: '/r/x', isDir: false }
  );
  assert.strictEqual(T.revealTarget(null, '/r'), null);
  assert.strictEqual(T.revealTarget({ path: '/r/x', ignored: true }, '/r'), null);
  assert.strictEqual(T.revealTarget({ path: '/r/x' }, null), null);
});

// ─────────────────────────────────────────────────────────────────────────
// 名字与输入行
// ─────────────────────────────────────────────────────────────────────────

test('baseName：取最后一段，目录尾斜杠后为空串', () => {
  assert.strictEqual(T.baseName('/a/b.md'), 'b.md');
  assert.strictEqual(T.baseName('abc'), 'abc');
  assert.strictEqual(T.baseName('/a/b'), 'b');
  assert.strictEqual(T.baseName('/'), '');
  assert.strictEqual(T.baseName('a/b/'), '');
});

test('selectStem：只选主名，后缀留在选区之外', () => {
  assert.deepStrictEqual(T.selectStem('note.md'), { start: 0, end: 4 });
  assert.deepStrictEqual(T.selectStem('a.b.md'), { start: 0, end: 3 });
  assert.deepStrictEqual(T.selectStem('README'), { start: 0, end: 6 });
  assert.deepStrictEqual(T.selectStem('.md'), { start: 0, end: 3 });
  assert.deepStrictEqual(T.selectStem('a.'), { start: 0, end: 1 });
  assert.deepStrictEqual(T.selectStem(''), { start: 0, end: 0 });
  assert.deepStrictEqual(T.selectStem(null), { start: 0, end: 0 });
});

test('inputAction：Enter 提交 / Escape 取消 / 其他键忽略', () => {
  assert.strictEqual(T.inputAction({ key: 'Enter' }), 'submit');
  assert.strictEqual(T.inputAction({ key: 'Escape' }), 'cancel');
  assert.strictEqual(T.inputAction({ key: 'a' }), 'ignore');
  assert.strictEqual(T.inputAction(null), 'ignore');
});

test('inputAction：组合态必须挡在提交之前（isComposing 或 keyCode 229）', () => {
  assert.strictEqual(T.inputAction({ key: 'Enter', isComposing: true }), 'composing');
  assert.strictEqual(T.inputAction({ key: 'Escape', isComposing: true }), 'composing');
  assert.strictEqual(T.inputAction({ key: 'Enter', keyCode: 229 }), 'composing');
  assert.strictEqual(T.inputAction({ key: 'Escape', keyCode: 229 }), 'composing');
  // 非 Enter/Escape 的键不参与组合态判定
  assert.strictEqual(T.inputAction({ key: 'a', isComposing: true }), 'ignore');
});

// ─────────────────────────────────────────────────────────────────────────
// 文案映射
// ─────────────────────────────────────────────────────────────────────────

test('copyFailKey：三类各自有键，未知 reason 落到“复制失败”', () => {
  assert.strictEqual(T.copyFailKey('unsupported'), 'tree.copy.unsupported');
  assert.strictEqual(T.copyFailKey('denied'), 'tree.copy.denied');
  assert.strictEqual(T.copyFailKey('failed'), 'tree.copy.failed');
  assert.strictEqual(T.copyFailKey('zzz'), 'tree.copy.failed');
  assert.strictEqual(T.copyFailKey(undefined), 'tree.copy.failed');
});

test('degradedKeys：只留认识的标签，顺序沿用入参', () => {
  assert.deepStrictEqual(T.degradedKeys(null), []);
  assert.deepStrictEqual(T.degradedKeys('x'), []);
  assert.deepStrictEqual(
    T.degradedKeys(['path_check', 'zzz', 'watch']),
    ['tree.rename.degraded.path_check', 'tree.rename.degraded.watch']
  );
});

test('highlightRenamed：重列完成那一刻当前文档确实换了名字才高亮', () => {
  assert.strictEqual(T.highlightRenamed('/r/b.md', '/r/b.md'), true);
  assert.strictEqual(T.highlightRenamed('/r/a.md', '/r/b.md'), false);
  assert.strictEqual(T.highlightRenamed(null, '/r/b.md'), false);
  assert.strictEqual(T.highlightRenamed('/r/b.md', null), false);
});

test('errorText：invalid_name / not_renamable 的 reason 走字典', () => {
  assert.strictEqual(
    T.errorText({ kind: 'invalid_name', raw: { reason: 'empty' } }, win.rmd.i18n.t),
    '名字不能为空'
  );
  assert.strictEqual(
    T.errorText({ kind: 'not_renamable', raw: { reason: 'symlink' } }, win.rmd.i18n.t),
    '这是符号链接，不能重命名'
  );
});

test('errorText：字典里没有的 reason 不印键名，退到 wording / message', () => {
  assert.strictEqual(
    T.errorText({ kind: 'invalid_name', raw: { reason: 'zzz' }, wording: 'w' }, win.rmd.i18n.t),
    'w'
  );
  assert.strictEqual(
    T.errorText({ kind: 'not_renamable', raw: { reason: 'zzz' }, wording: 'w2' }, win.rmd.i18n.t),
    'w2'
  );
  assert.strictEqual(T.errorText({ message: 'm' }, win.rmd.i18n.t), 'm');
});

test('errorText：什么都没有时说“操作失败”，⛔ 返回空串', () => {
  assert.strictEqual(T.errorText(null, win.rmd.i18n.t), '');
  assert.strictEqual(T.errorText({}, win.rmd.i18n.t), '操作失败');
  // 译者返回键本身（字典缺这条）时同样退到兜底
  assert.strictEqual(T.errorText({}, function (k) { return k; }), 'err.kind.other');
});

test('常量与映射表：重试预算与三张字面量表', () => {
  assert.strictEqual(T.MAX_RETRIES, 2);
  assert.strictEqual(T.RETRY_DELAY_MS, 1000);
  assert.deepStrictEqual(T.RENAME_REASON_KEY, {
    symlink: 'err.rename.symlink',
    not_markdown: 'err.rename.not_markdown',
    editing: 'err.rename.editing',
  });
  assert.deepStrictEqual(T.DEGRADED_KEY, {
    watch: 'tree.rename.degraded.watch',
    path_check: 'tree.rename.degraded.path_check',
  });
  assert.deepStrictEqual(T.COPY_FAIL_KEY, {
    unsupported: 'tree.copy.unsupported',
    denied: 'tree.copy.denied',
    failed: 'tree.copy.failed',
  });
});
