// 文件树刷新回归：`src/services/treerefresh.js` 的层 epoch、按路径请求序、
// 事务去留决策、滚动锚点、右键目标与输入行按键语义。
//
// 从历史缺陷出发，守三族**静默**错误：
//   · `0019` 外部新增文件不出现 —— 层 epoch 记错就有“刷新也没用”，画面不报错；
//   · `0064` 旧回包改状态 —— 父子层同时展开时全局序号会把正常并发互相判死，
//     或把别人的回包当成自己的；
//   · `0035` / 中文输入法 —— 组合态里的回车提交半截拼音，名字规则却看起来都“合法”。
// 另外守 `0217` 同族的路径洁净：前端⛔ 不拼、不裁、不转义后端给的路径。
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
loadInto(win, 'src/services/treerefresh.js');
const T = win.rmd.treeRefresh;

// ─────────────────────────────────────────────────────────────────────────
// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
// 变体：层 epoch、按路径请求序、事务复核。
// ─────────────────────────────────────────────────────────────────────────

test('0019/没记过 epoch 的层算旧：新展开的层当然要列一次', () => {
  assert.strictEqual(T.staleLayer(new Map(), '/r/a', 3), true);
});

test('0019/epoch 相同算新，不同算旧', () => {
  const m = new Map([['/r/a', 3]]);
  assert.strictEqual(T.staleLayer(m, '/r/a', 3), false);
  assert.strictEqual(T.staleLayer(m, '/r/a', 4), true);
});

test('0019/中文路径的层键按原串记，不归一化', () => {
  const m = new Map([['/资料/笔记', 2]]);
  assert.strictEqual(T.staleLayer(m, '/资料/笔记', 2), false);
  assert.strictEqual(T.staleLayer(m, '/资料/笔记/', 2), true);
});

test('0019/请求序按路径各自从 1 开始，父子层并发不会互相判死', () => {
  const seq = new Map();
  assert.strictEqual(T.nextSeq(seq, '/r'), 1);
  assert.strictEqual(T.nextSeq(seq, '/r/a'), 1);
  assert.strictEqual(T.nextSeq(seq, '/r'), 2);
  assert.strictEqual(T.nextSeq(seq, '/r/a'), 2);
  assert.strictEqual(T.nextSeq(seq, '/r'), 3);
});

test('0064/isCurrent：每层只认自己最新的那个请求号', () => {
  const seq = new Map();
  const parent1 = T.nextSeq(seq, '/r');
  const child1 = T.nextSeq(seq, '/r/a');
  const parent2 = T.nextSeq(seq, '/r');
  assert.strictEqual(T.isCurrent(seq, '/r', parent1), false);
  assert.strictEqual(T.isCurrent(seq, '/r', parent2), true);
  assert.strictEqual(T.isCurrent(seq, '/r/a', child1), true, '父层的新请求不该把子层判死');
});

test('0019/decide：三个身份都没变时才提交', () => {
  assert.deepStrictEqual(
    T.decide({ gen0: 1, gen: 1, token0: 2, token: 2, version0: 3, version: 3, seq0: 4, seq: 4 }),
    { action: 'commit', reason: 'ok', retry: false, delayMs: 0 }
  );
});

test('0019/decide：会话令牌变了 ⇒ 整棵树换了，丢弃且不重跑', () => {
  assert.deepStrictEqual(
    T.decide({ gen0: 1, gen: 1, token0: 1, token: 2, version0: 0, version: 0 }),
    { action: 'discard', reason: 'cancelled', retry: false, delayMs: 0 }
  );
});

test('0019/decide：授权代次变了 ⇒ 结果作废，丢弃且不重跑', () => {
  assert.deepStrictEqual(
    T.decide({ gen0: 1, gen: 2, token0: 1, token: 1, version0: 0, version: 0 }),
    { action: 'discard', reason: 'stale', retry: false, delayMs: 0 }
  );
});

test('0019/decide：盘上内容变了（seq 变了）⇒ 必须重跑，等 1 s', () => {
  assert.deepStrictEqual(
    T.decide({ gen0: 1, gen: 1, token0: 1, token: 1, version0: 0, version: 0, seq0: 2, seq: 3 }),
    { action: 'discard', reason: 'rev', retry: true, delayMs: T.RETRY_DELAY_MS }
  );
});

test('0019/decide：seq 缺一个就当“没观测”，⛔ 不白重跑一轮', () => {
  const base = { gen0: 1, gen: 1, token0: 1, token: 1, version0: 0, version: 0 };
  assert.strictEqual(T.decide(base).action, 'commit');
  assert.strictEqual(T.decide(Object.assign({ seq0: 2 }, base)).action, 'commit');
  assert.strictEqual(T.decide(Object.assign({ seq: 2 }, base)).action, 'commit');
});

test('0019/decide：rev 重跑次数用尽 ⇒ give_up，交给下一次事件', () => {
  assert.deepStrictEqual(
    T.decide({ gen0: 1, gen: 1, token0: 1, token: 1, version0: 0, version: 0, seq0: 2, seq: 3, retries: T.MAX_RETRIES }),
    { action: 'give_up', reason: 'rev', retry: false, delayMs: 0 }
  );
});

test('0035/decide：用户动了树（version 变了）第一次立即重跑', () => {
  assert.deepStrictEqual(
    T.decide({ gen0: 1, gen: 1, token0: 1, token: 1, version0: 4, version: 5, retries: 0 }),
    { action: 'discard', reason: 'user', retry: true, delayMs: 0 }
  );
});

test('0035/decide：用户第二次打断 ⇒ 隔 1 s 再试', () => {
  assert.deepStrictEqual(
    T.decide({ gen0: 1, gen: 1, token0: 1, token: 1, version0: 4, version: 5, retries: 1 }),
    { action: 'discard', reason: 'user', retry: true, delayMs: T.RETRY_DELAY_MS }
  );
});

test('0035/decide：重跑预算用尽 ⇒ give_up user，调用方留待下次事件', () => {
  assert.deepStrictEqual(
    T.decide({ gen0: 1, gen: 1, token0: 1, token: 1, version0: 4, version: 5, retries: 2 }),
    { action: 'give_up', reason: 'user', retry: false, delayMs: 0 }
  );
});

test('0064/decide：token 与 gen 同时变时先判 token（整棵树的身份优先）', () => {
  assert.strictEqual(T.decide({
    gen0: 1, gen: 2, token0: 1, token: 2, version0: 0, version: 0,
  }).reason, 'cancelled');
});

test('0019/decide：rev 与 stale 处置相反，⛔ 不合并成一个 reason', () => {
  const rev = T.decide({ gen0: 1, gen: 1, token0: 1, token: 1, version0: 0, version: 0, seq0: 1, seq: 2, retries: 0 });
  const stale = T.decide({ gen0: 1, gen: 2, token0: 1, token: 1, version0: 0, version: 0, seq0: 1, seq: 2, retries: 0 });
  assert.strictEqual(rev.retry, true);
  assert.strictEqual(stale.retry, false);
});

test('0019/挂起判据：输入行 / 创建中 / 已有事务任一成立都不动 DOM', () => {
  assert.strictEqual(T.shouldDefer({ inputOpen: true }), true);
  assert.strictEqual(T.shouldDefer({ creating: true }), true);
  assert.strictEqual(T.shouldDefer({ running: true }), true);
  assert.strictEqual(T.shouldDefer({}), false);
  assert.strictEqual(T.shouldDefer(null), false);
});

test('0035/手动刷新置灰只看输入行与创建中，事务在跑不置灰', () => {
  assert.strictEqual(T.manualDisabled({ inputOpen: true }), true);
  assert.strictEqual(T.manualDisabled({ creating: true }), true);
  assert.strictEqual(T.manualDisabled({ running: true }), false);
  assert.strictEqual(T.manualDisabled(null), false);
});

// ─────────────────────────────────────────────────────────────────────────
// 路径与顺序：祖先先于后代，⛔ 不写第二份路径真值
// ─────────────────────────────────────────────────────────────────────────

test('0019/depthOf 按非空段数算，尾斜杠与根都是 0 层', () => {
  assert.strictEqual(T.depthOf('/a/b'), 2);
  assert.strictEqual(T.depthOf('/a/b/'), 2);
  assert.strictEqual(T.depthOf('/a'), 1);
  assert.strictEqual(T.depthOf('/'), 0);
  assert.strictEqual(T.depthOf(''), 0);
  assert.strictEqual(T.depthOf('/资料/笔记'), 2);
});

test('0019/sortShallowFirst：浅的在前，同深度按码元字面序', () => {
  assert.deepStrictEqual(
    T.sortShallowFirst(['/r/b/c', '/r/笔记', '/r/a', '/r/b', '/r/啊']),
    ['/r/a', '/r/b', '/r/啊', '/r/笔记', '/r/b/c']
  );
});

test('0019/parentOf：普通嵌套、根下一层、无斜杠、根', () => {
  assert.strictEqual(T.parentOf('/r/a/b.md'), '/r/a');
  assert.strictEqual(T.parentOf('/a.md'), '/');
  assert.strictEqual(T.parentOf('a.md'), '');
  assert.strictEqual(T.parentOf('/'), '/');
  assert.strictEqual(T.parentOf(''), '');
});

test('0019/descendants：只收真后代，前缀陷阱与自身都排除', () => {
  const expanded = new Set(['/r/a', '/r/a/b', '/r/a/b/c', '/r/ab', '/r/a2/x', '/r/a']);
  assert.deepStrictEqual(T.descendants(expanded, '/r/a'), ['/r/a/b', '/r/a/b/c']);
});

test('0019/descendants：返回由浅到深的快照数组', () => {
  const out = T.descendants(['/r/x/y/z', '/r/x/y', '/r/x'], '/r/x');
  assert.deepStrictEqual(out, ['/r/x/y', '/r/x/y/z']);
  assert.ok(Array.isArray(out));
});

test('0019/descendants：空集合 / 无后代都返回空数组', () => {
  assert.deepStrictEqual(T.descendants(new Set(), '/r'), []);
  assert.deepStrictEqual(T.descendants(['/r/a'], '/r/a'), []);
});

// ─────────────────────────────────────────────────────────────────────────
// 滚动锚点：刷新后不把用户的位置扔掉
// ─────────────────────────────────────────────────────────────────────────

test('0019/anchorRow：取第一个底边越过容器顶边的可见行', () => {
  const rows = [
    { path: '/a', top: -40, bottom: 0 },
    { path: '/b', top: 20, bottom: 60 },
    { path: '/c', top: 80, bottom: 120 },
  ];
  assert.deepStrictEqual(T.anchorRow(rows, 10), { path: '/b', offset: 10 }); // 第一行 bottom=0 不越过
});

test('0019/anchorRow：行顶边可以高于容器顶边，offset 为负', () => {
  const rows = [{ path: '/a', top: -25, bottom: 15 }];
  assert.deepStrictEqual(T.anchorRow(rows, 0), { path: '/a', offset: -25 });
});

test('0019/anchorRow：没有可见行时返回 null，⛔ 不造一个空锚点', () => {
  assert.strictEqual(T.anchorRow([], 0), null);
  assert.strictEqual(T.anchorRow([{ path: '/a', top: -50, bottom: -10 }], 0), null);
});

test('0019/restoreOffset：锚点行还在 ⇒ 返回滚动增量', () => {
  const rows = [{ path: '/a', top: 100 }, { path: '/b', top: 300 }];
  assert.strictEqual(T.restoreOffset({ path: '/b', offset: 20 }, rows, 0), 280);
  assert.strictEqual(T.restoreOffset({ path: '/a', offset: -10 }, rows, 50), 60);
});

test('0019/restoreOffset：锚点行没了 ⇒ 退到最近的存活祖先', () => {
  const rows = [{ path: '/r', top: 0 }, { path: '/r/a', top: 200 }];
  // 最近存活祖先是 `/r/a`：行顶 200 − 容器顶 10 − 锚点内偏移 5。
  assert.strictEqual(T.restoreOffset({ path: '/r/a/b/c.md', offset: 5 }, rows, 10), 185);
});

test('0019/restoreOffset：祖先也不在 ⇒ null，只夹滚动范围，⛔ 不回顶部', () => {
  const rows = [{ path: '/other', top: 0 }];
  assert.strictEqual(T.restoreOffset({ path: '/r/a/b.md', offset: 5 }, rows, 0), null);
});

test('0019/restoreOffset：没有锚点 ⇒ null', () => {
  assert.strictEqual(T.restoreOffset(null, [{ path: '/a', top: 0 }], 0), null);
});

test('0019/restoreOffset：parentOf 原地打转时不变成死循环', () => {
  const rows = [{ path: '/x', top: 0 }];
  const out = T.restoreOffset({ path: '/a', offset: 0 }, rows, 0, function (p) { return p; });
  assert.strictEqual(out, null);
});

// ─────────────────────────────────────────────────────────────────────────
// 右键目标：⛔ 不拼路径、不 trim、不转义
// ─────────────────────────────────────────────────────────────────────────

test('0019/右键空白处 ⇒ 新条目落在根目录', () => {
  assert.deepStrictEqual(T.resolveMenuTarget(null, '/r'), { dir: '/r', kind: 'blank' });
});

test('0019/右键目录行 ⇒ 落在该目录；右键文件行 ⇒ 落在父目录', () => {
  assert.deepStrictEqual(T.resolveMenuTarget({ path: '/r/notes', isDir: true }, '/r'),
    { dir: '/r/notes', kind: 'dir' });
  assert.deepStrictEqual(T.resolveMenuTarget({ path: '/r/notes/a.md', isDir: false }, '/r'),
    { dir: '/r/notes', kind: 'file' });
});

test('0019/右键根下文件 ⇒ 父目录就是根（paths 本来就来自 list_dir）', () => {
  assert.deepStrictEqual(T.resolveMenuTarget({ path: '/r/a.md', isDir: false }, '/r'),
    { dir: '/r', kind: 'file' });
});

test('0019/右键没有分隔符的异常路径 ⇒ 空父目录回落到根，⛔ 不给空 dir', () => {
  assert.deepStrictEqual(T.resolveMenuTarget({ path: 'a.md', isDir: false }, '/r'),
    { dir: '/r', kind: 'file' });
});

test('0019/灰显目录与没有根都不出菜单', () => {
  assert.strictEqual(T.resolveMenuTarget({ path: '/r/node_modules', isDir: true, ignored: true }, '/r'), null);
  assert.strictEqual(T.resolveMenuTarget(null, null), null);
  assert.strictEqual(T.resolveMenuTarget({ path: '/r/a.md', isDir: false }, ''), null);
});

test('0035/复制路径：文件与目录都原样返回，尾随空格与引号都不动', () => {
  const weird = '/r/带 空格/名字"引号".md ';
  assert.strictEqual(T.copyTarget({ path: weird, isDir: false }, '/r'), weird);
  assert.strictEqual(T.copyTarget({ path: '/r/资料', isDir: true }, '/r'), '/r/资料');
});

test('0035/复制路径：空白处 / 灰显 / 空路径 / 没有根一律不出这一项', () => {
  assert.strictEqual(T.copyTarget(null, '/r'), null);
  assert.strictEqual(T.copyTarget({ path: '/r/a', ignored: true }, '/r'), null);
  assert.strictEqual(T.copyTarget({ path: '', isDir: false }, '/r'), null);
  assert.strictEqual(T.copyTarget({ path: '/r/a', isDir: false }, null), null);
});

test('0035/重命名：只有文件行有这一项，目录 / 空白 / 灰显都没有', () => {
  assert.deepStrictEqual(T.renameTarget({ path: '/r/a.md', isDir: false }, '/r'),
    { path: '/r/a.md', disabled: false });
  assert.strictEqual(T.renameTarget({ path: '/r/d', isDir: true }, '/r'), null);
  assert.strictEqual(T.renameTarget(null, '/r'), null);
  assert.strictEqual(T.renameTarget({ path: '/r/a.md', isDir: false, ignored: true }, '/r'), null);
});

test('0035/重命名：当前文档正在编辑时置灰，别的文件不受影响', () => {
  const hit = { path: '/r/a.md', isDir: false };
  assert.deepStrictEqual(T.renameTarget(hit, '/r', { editing: true, current: '/r/a.md' }),
    { path: '/r/a.md', disabled: true, reason: 'editing' });
  assert.deepStrictEqual(T.renameTarget(hit, '/r', { editing: true, current: '/r/b.md' }),
    { path: '/r/a.md', disabled: false });
});

test('0048/在访达中显示：文件与目录都返回原路径，isDir 只当提示', () => {
  assert.deepStrictEqual(T.revealTarget({ path: '/r/a.md', isDir: false }, '/r'),
    { path: '/r/a.md', isDir: false });
  assert.deepStrictEqual(T.revealTarget({ path: '/r/资料', isDir: true }, '/r'),
    { path: '/r/资料', isDir: true });
  assert.strictEqual(T.revealTarget(null, '/r'), null);
  assert.strictEqual(T.revealTarget({ path: '/r/a', ignored: true }, '/r'), null);
  assert.strictEqual(T.revealTarget({ path: '/r/a', isDir: false }, null), null);
});

// ─────────────────────────────────────────────────────────────────────────
// 名字与输入行：中文输入法组合态必须先挡住提交
// ─────────────────────────────────────────────────────────────────────────

test('0035/baseName：取最后一段，根与空串安全', () => {
  assert.strictEqual(T.baseName('/a/b.md'), 'b.md');
  assert.strictEqual(T.baseName('/a/b/'), '');
  assert.strictEqual(T.baseName('abc'), 'abc');
  assert.strictEqual(T.baseName('/'), '');
  assert.strictEqual(T.baseName(''), '');
});

test('0035/selectStem：只选主名，扩展名留在选中范围外', () => {
  assert.deepStrictEqual(T.selectStem('note.md'), { start: 0, end: 4 });
  assert.deepStrictEqual(T.selectStem('a.b.md'), { start: 0, end: 3 });
  assert.deepStrictEqual(T.selectStem('中文笔记.md'), { start: 0, end: 4 });
});

test('0035/selectStem：没有点 / 以点开头时全选，⛔ 不给空选区', () => {
  assert.deepStrictEqual(T.selectStem('notes'), { start: 0, end: 5 });
  assert.deepStrictEqual(T.selectStem('.md'), { start: 0, end: 3 });
  assert.deepStrictEqual(T.selectStem('.gitignore'), { start: 0, end: 10 });
  assert.deepStrictEqual(T.selectStem(''), { start: 0, end: 0 });
});

test('0035/输入行：Enter 提交、Escape 取消', () => {
  assert.strictEqual(T.inputAction({ key: 'Enter' }), 'submit');
  assert.strictEqual(T.inputAction({ key: 'Escape' }), 'cancel');
});

test('0035/输入行：组合态里的 Enter 必须先挡在提交之前（⛔ 不提交半截拼音）', () => {
  assert.strictEqual(T.inputAction({ key: 'Enter', isComposing: true }), 'composing');
  assert.strictEqual(T.inputAction({ key: 'Enter', keyCode: 229 }), 'composing');
  assert.strictEqual(T.inputAction({ key: 'Escape', isComposing: true }), 'composing');
});

test('0035/输入行：别的键与空事件一律忽略', () => {
  assert.strictEqual(T.inputAction({ key: 'a' }), 'ignore');
  assert.strictEqual(T.inputAction({ key: 'Tab' }), 'ignore');
  assert.strictEqual(T.inputAction({}), 'ignore');
  assert.strictEqual(T.inputAction(null), 'ignore');
});

// ─────────────────────────────────────────────────────────────────────────
// 文案映射：只有查表，⛔ 不重新判一遍名字规则
// ─────────────────────────────────────────────────────────────────────────

test('0035/degradedKeys：只翻已知标签，未知的静默丢掉', () => {
  assert.deepStrictEqual(T.degradedKeys(['watch', 'path_check']),
    ['tree.rename.degraded.watch', 'tree.rename.degraded.path_check']);
  assert.deepStrictEqual(T.degradedKeys(['watch', '未知']), ['tree.rename.degraded.watch']);
  assert.deepStrictEqual(T.degradedKeys(null), []);
  assert.deepStrictEqual(T.degradedKeys('watch'), []);
});

test('0035/copyFailKey：三类失败各有文案，未知原因落到“复制失败”', () => {
  assert.strictEqual(T.copyFailKey('unsupported'), 'tree.copy.unsupported');
  assert.strictEqual(T.copyFailKey('denied'), 'tree.copy.denied');
  assert.strictEqual(T.copyFailKey('failed'), 'tree.copy.failed');
  assert.strictEqual(T.copyFailKey('其它'), 'tree.copy.failed');
  assert.strictEqual(T.copyFailKey(undefined), 'tree.copy.failed');
});

test('0035/highlightRenamed：只在重列完成那一刻当前路径仍是新路径时高亮', () => {
  assert.strictEqual(T.highlightRenamed('/r/新.md', '/r/新.md'), true);
  assert.strictEqual(T.highlightRenamed('/r/别的.md', '/r/新.md'), false);
  assert.strictEqual(T.highlightRenamed('/r/新.md', null), false);
  assert.strictEqual(T.highlightRenamed('/r/新.md', ''), false);
});

test('0035/errorText：invalid_name 走字典键，查不到才退回原文', () => {
  const t = function (k) { return 'T:' + k; };
  assert.strictEqual(
    T.errorText({ kind: 'invalid_name', raw: { reason: 'empty' } }, t),
    'T:err.name.empty'
  );
  const missing = function (k) { return k; };
  assert.strictEqual(
    T.errorText({ kind: 'invalid_name', raw: { reason: '空名字' }, wording: '名字不能为空' }, missing),
    '名字不能为空'
  );
});

test('0035/errorText：not_renamable 的三种 reason 走字面量表', () => {
  const t = function (k) { return 'T:' + k; };
  assert.strictEqual(T.errorText({ kind: 'not_renamable', raw: { reason: 'symlink' } }, t),
    'T:err.rename.symlink');
  assert.strictEqual(T.errorText({ kind: 'not_renamable', raw: { reason: 'not_markdown' } }, t),
    'T:err.rename.not_markdown');
  assert.strictEqual(T.errorText({ kind: 'not_renamable', raw: { reason: 'editing' } }, t),
    'T:err.rename.editing');
});

test('0035/errorText：未知 reason 不猜更具体的说法，退回 wording / message / 兜底', () => {
  const t = function (k) { return 'T:' + k; };
  assert.strictEqual(T.errorText({ kind: 'not_renamable', raw: { reason: '未来的原因' }, wording: '白话' }, t), '白话');
  assert.strictEqual(T.errorText({ kind: 'not_renamable', raw: { reason: 'x' }, message: '原始消息' }, t), '原始消息');
  assert.strictEqual(T.errorText({ kind: 'not_renamable', raw: { reason: 'x' } }, t), 'T:err.kind.other');
});

test('0035/errorText：空事件返回空串，reason 不是非空字符串时跳过查表', () => {
  assert.strictEqual(T.errorText(null, function (k) { return k; }), '');
  assert.strictEqual(T.errorText({ raw: { reason: 7 }, message: '消息' }, function (k) { return k; }), '消息');
  assert.strictEqual(T.errorText({ raw: { reason: '' }, wording: '说明' }, function (k) { return k; }), '说明');
});
