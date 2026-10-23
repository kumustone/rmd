// `design/0034` §2.1 A / C 的**纯逻辑**判据：层 epoch 判脏、按路径请求序、
// 刷新事务去留、滚动锚点换算、右键目标、输入行按键语义、错误文案映射。
//
// ⚠️ 这些断言的错法**大多是静默的**：
//    `staleLayer` 用 `!==` 而不是"没记过也算旧"⇒ 新展开的层永远不列；
//    `nextSeq` 用全局序号 ⇒ 父子层正常并发互相判死；
//    `decide` 把 `token` 判在 `gen` 之后 ⇒ 切根后旧代次的回包被当成可提交；
//    `inputAction` 漏掉组合态 ⇒ 中文选词的回车提交半截拼音（`INV-SET-05` 同族）；
//    `errorText` 自己再判一遍名字规则 ⇒ 与后端 `INV-TREE-07` 变成两份真值。
// ⇒ 逐条钉边界，⛔ 不靠"看起来对"。
//
// ⭐ **DOM / IPC 一律不在这里**：那一半在 `FileTree.js`（`tests/js/` 没有 DOM），
//    接线由 `make probe-tree-menu` 的离屏探针盯（需要真 DOM 才成立）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../../src/services/treerefresh.js');

const ROOT = path.join(__dirname, '..', '..');

// ── A.1 层 epoch 判脏 ────────────────────────────────────────────────

test('staleLayer：没记过也算旧（新展开的层当然要列一次）', function () {
  assert.strictEqual(R.staleLayer(new Map(), '/a', 1), true);
});

test('staleLayer：记的值等于当前 epoch ⇒ 不算旧', function () {
  const m = new Map([['/a', 3]]);
  assert.strictEqual(R.staleLayer(m, '/a', 3), false);
});

test('staleLayer：记的值早于当前 epoch ⇒ 旧', function () {
  assert.strictEqual(R.staleLayer(new Map([['/a', 2]]), '/a', 3), true);
});

test('staleLayer：⚠️ 记的值比当前 epoch 大也算旧（`!==`，⛔ 不是 `<`）', function () {
  // 回包时 epoch 只可能不相等；用 `<` 会把"回包后 epoch 被回退"这种异常
  // 当成"还是新的"，而那一层其实已经没人说得清是不是当前内容了。
  assert.strictEqual(R.staleLayer(new Map([['/a', 9]]), '/a', 3), true);
});

// ── A.2 按路径的请求序 ───────────────────────────────────────────────

test('nextSeq：同一层从 1 起递增', function () {
  const m = new Map();
  assert.strictEqual(R.nextSeq(m, '/a'), 1);
  assert.strictEqual(R.nextSeq(m, '/a'), 2);
  assert.strictEqual(R.nextSeq(m, '/a'), 3);
});

test('nextSeq：⚠️ 各自独立——父层的序号不推动子层', function () {
  const m = new Map();
  assert.strictEqual(R.nextSeq(m, '/a'), 1);
  assert.strictEqual(R.nextSeq(m, '/a/b'), 1);
  assert.strictEqual(R.nextSeq(m, '/a'), 2);
  assert.strictEqual(R.nextSeq(m, '/a/b'), 2);
});

test('isCurrent：只有最后那次请求算数', function () {
  const m = new Map();
  const s1 = R.nextSeq(m, '/a');
  const s2 = R.nextSeq(m, '/a');
  assert.strictEqual(R.isCurrent(m, '/a', s1), false);
  assert.strictEqual(R.isCurrent(m, '/a', s2), true);
});

test('isCurrent：别的层推进不影响这一层', function () {
  const m = new Map();
  const s1 = R.nextSeq(m, '/a');
  R.nextSeq(m, '/b');
  assert.strictEqual(R.isCurrent(m, '/a', s1), true);
});

// ── 深度 / 排序 / 父子 / 后代 ────────────────────────────────────────

test('depthOf：按非空段数算', function () {
  assert.strictEqual(R.depthOf('/'), 0);
  assert.strictEqual(R.depthOf('/a'), 1);
  assert.strictEqual(R.depthOf('/a/b/c'), 3);
  assert.strictEqual(R.depthOf(''), 0);
  assert.strictEqual(R.depthOf('/a//b'), 2); // 空段不算一层
});

test('sortShallowFirst：浅→深，同深度按字面序', function () {
  const out = R.sortShallowFirst(['/a/b/c', '/b', '/a/b', '/a']);
  assert.deepStrictEqual(out, ['/a', '/b', '/a/b', '/a/b/c']);
});

test('sortShallowFirst：不修改入参', function () {
  const src = ['/a/b', '/a'];
  R.sortShallowFirst(src);
  assert.deepStrictEqual(src, ['/a/b', '/a']);
});

test('parentOf：普通路径去掉最后一段', function () {
  assert.strictEqual(R.parentOf('/a/b/c'), '/a/b');
  assert.strictEqual(R.parentOf('/a/b'), '/a');
});

test('parentOf：⚠️ 根下第一层的父是 `/`，⛔ 不是空串', function () {
  assert.strictEqual(R.parentOf('/abc'), '/');
  assert.strictEqual(R.parentOf('/'), '/');
});

test('parentOf：没有分隔符 ⇒ 空串（调用方据此退回根目录）', function () {
  assert.strictEqual(R.parentOf('abc'), '');
});

test('descendants：只取 `path` 之下、⛔ 不含自己，且浅→深', function () {
  const expanded = new Set(['/a', '/a/b', '/a/b/c', '/ab', '/x']);
  assert.deepStrictEqual(R.descendants(expanded, '/a'), ['/a/b', '/a/b/c']);
});

test('descendants：⚠️ 前缀要带分隔符——`/ab` 不是 `/a` 的后代', function () {
  assert.deepStrictEqual(R.descendants(new Set(['/ab', '/a/x']), '/a'), ['/a/x']);
});

test('descendants：返回快照（活集合随后被清掉也不影响）', function () {
  const expanded = new Set(['/a', '/a/b']);
  const snap = R.descendants(expanded, '/a');
  expanded.clear();
  assert.deepStrictEqual(snap, ['/a/b']);
});

test('descendants：`path` 已带尾斜杠时不拼成双斜杠', function () {
  assert.deepStrictEqual(R.descendants(new Set(['/a/b']), '/a/'), ['/a/b']);
});

// ── A.2 第 2 条：滚动锚点 ────────────────────────────────────────────

test('anchorRow：取第一个底边越过容器顶边的行', function () {
  const rows = [
    { path: '/above', top: 20, bottom: 50 },
    { path: '/first', top: 60, bottom: 90 },
    { path: '/second', top: 100, bottom: 130 },
  ];
  // 容器顶边 = 55：`/above` 的上半被滚掉了，但它仍压着顶边 ⇒ ⛔ 不是锚点
  // （用户眼里第一行是 `/first`，而它在屏幕上是完整的）。
  assert.deepStrictEqual(R.anchorRow(rows, 55), { path: '/first', offset: 5 });
});

test('anchorRow：⚠️ 被滚掉一半的那一行仍可当锚点（底边越线即可）', function () {
  const rows = [
    { path: '/half', top: 40, bottom: 70 },
    { path: '/next', top: 80, bottom: 110 },
  ];
  assert.deepStrictEqual(R.anchorRow(rows, 55), { path: '/half', offset: -15 });
});

test('anchorRow：没有可见行 ⇒ null', function () {
  assert.strictEqual(R.anchorRow([], 0), null);
  assert.strictEqual(R.anchorRow([{ path: '/a', top: 0, bottom: 0 }], 100), null);
});

test('restoreOffset：锚点还在 ⇒ 把它的顶边挪回原来的偏移', function () {
  // 旧偏移 -5（行顶在容器顶上方 5px）；新树里它跑到了 +95 ⇒ 要往上挪 100。
  const delta = R.restoreOffset(
    { path: '/a', offset: -5 },
    [{ path: '/a', top: 95 }],
    0
  );
  assert.strictEqual(delta, 100);
});

test('restoreOffset：锚点没了 ⇒ 退到最近的存活祖先', function () {
  const rows = [{ path: '/a', top: 30 }, { path: '/a/other', top: 60 }];
  // 锚点 `/a/b/c` 被删；最近的存活祖先是 `/a`（`/a/b` 也不在了）。
  const delta = R.restoreOffset({ path: '/a/b/c', offset: 10 }, rows, 0);
  assert.strictEqual(delta, 20);
});

test('restoreOffset：⚠️ 祖先也不在 ⇒ null（调用方只夹取滚动范围，⛔ 不回顶部）', function () {
  assert.strictEqual(
    R.restoreOffset({ path: '/gone/x', offset: 0 }, [{ path: '/other', top: 0 }], 0),
    null
  );
});

test('restoreOffset：没有锚点 ⇒ null', function () {
  assert.strictEqual(R.restoreOffset(null, [{ path: '/a', top: 0 }], 0), null);
});

test('restoreOffset：⚠️ `parentOfFn` 原地打转也不许死循环', function () {
  let calls = 0;
  const loop = function (p) { calls += 1; return p; };
  assert.strictEqual(
    R.restoreOffset({ path: '/a', offset: 0 }, [], 0, loop),
    null
  );
  assert.ok(calls <= 1, 'parentOfFn 返回自身时应当立刻收手');
});

test('restoreOffset：祖先链一直走到根', function () {
  const rows = [{ path: '/', top: 12 }];
  assert.strictEqual(R.restoreOffset({ path: '/a/b/c', offset: 2 }, rows, 0), 10);
});

// ── A.2 第 4 条：事务去留 ────────────────────────────────────────────

/** 一份"三个身份都没变"的最小快照。 */
function mkDecide(over) {
  return Object.assign({
    token0: 1, token: 1,
    gen0: 7, gen: 7,
    version0: 3, version: 3,
    retries: 0,
  }, over);
}

test('decide：三个身份相等 ⇒ commit', function () {
  assert.deepStrictEqual(R.decide(mkDecide()), {
    action: 'commit', reason: 'ok', retry: false, delayMs: 0,
  });
});

test('decide：会话令牌变了 ⇒ cancelled，⛔ 不重跑（整棵树都换了）', function () {
  const d = R.decide(mkDecide({ token: 2 }));
  assert.strictEqual(d.action, 'discard');
  assert.strictEqual(d.reason, 'cancelled');
  assert.strictEqual(d.retry, false);
});

test('decide：⚠️ 令牌变了优先于代次——两个都变也只报 cancelled', function () {
  const d = R.decide(mkDecide({ token: 2, gen: 8 }));
  assert.strictEqual(d.reason, 'cancelled');
});

test('decide：后端代次变了 ⇒ stale，⛔ 不重跑（这一轮结果已作废）', function () {
  const d = R.decide(mkDecide({ gen: 8 }));
  assert.strictEqual(d.action, 'discard');
  assert.strictEqual(d.reason, 'stale');
  assert.strictEqual(d.retry, false);
});

test('decide：展开版本变了 ⇒ 第一次立即重跑', function () {
  const d = R.decide(mkDecide({ version: 4, retries: 0 }));
  assert.deepStrictEqual(d, {
    action: 'discard', reason: 'user', retry: true, delayMs: 0,
  });
});

test('decide：第二次（retries=1）隔 1 s 重跑', function () {
  const d = R.decide(mkDecide({ version: 4, retries: 1 }));
  assert.strictEqual(d.action, 'discard');
  assert.strictEqual(d.retry, true);
  assert.strictEqual(d.delayMs, R.RETRY_DELAY_MS);
  assert.strictEqual(R.RETRY_DELAY_MS, 1000);
});

test('decide：到上限（retries=2）⇒ give_up，⛔ 再重跑就成了循环', function () {
  const d = R.decide(mkDecide({ version: 4, retries: R.MAX_RETRIES }));
  assert.deepStrictEqual(d, {
    action: 'give_up', reason: 'user', retry: false, delayMs: 0,
  });
  assert.strictEqual(R.MAX_RETRIES, 2);
});

test('decide：`retries` 缺省按 0 算', function () {
  const d = R.decide({ token0: 1, token: 1, gen0: 1, gen: 1, version0: 1, version: 2 });
  assert.strictEqual(d.retry, true);
  assert.strictEqual(d.delayMs, 0);
});

// ── A.3 挂起 / 菜单置灰 ─────────────────────────────────────────────

test('shouldDefer：输入行开着 / 创建在飞 / 事务在跑，任一成立都挂起', function () {
  assert.strictEqual(R.shouldDefer({ inputOpen: true }), true);
  assert.strictEqual(R.shouldDefer({ creating: true }), true);
  assert.strictEqual(R.shouldDefer({ running: true }), true);
  assert.strictEqual(R.shouldDefer({}), false);
  assert.strictEqual(R.shouldDefer(null), false);
});

test('manualDisabled：⚠️ 事务在跑**不**置灰（再点只会排到后面）', function () {
  assert.strictEqual(R.manualDisabled({ running: true }), false);
  assert.strictEqual(R.manualDisabled({ inputOpen: true }), true);
  assert.strictEqual(R.manualDisabled({ creating: true }), true);
  assert.strictEqual(R.manualDisabled({}), false);
});

// ── C.1 右键目标 ─────────────────────────────────────────────────────

test('resolveMenuTarget：没有根（空会话）⇒ 不出菜单', function () {
  assert.strictEqual(R.resolveMenuTarget(null, null), null);
  assert.strictEqual(R.resolveMenuTarget({ path: '/a', isDir: true }, ''), null);
});

test('resolveMenuTarget：目录行 ⇒ 该目录', function () {
  assert.deepStrictEqual(
    R.resolveMenuTarget({ path: '/r/sub', isDir: true }, '/r'),
    { dir: '/r/sub', kind: 'dir' }
  );
});

test('resolveMenuTarget：文件行 ⇒ 父目录（只从路径切，⛔ 不拼新路径）', function () {
  assert.deepStrictEqual(
    R.resolveMenuTarget({ path: '/r/sub/a.md', isDir: false }, '/r'),
    { dir: '/r/sub', kind: 'file' }
  );
});

test('resolveMenuTarget：文件行在根下 ⇒ 根目录', function () {
  assert.deepStrictEqual(
    R.resolveMenuTarget({ path: '/a.md', isDir: false }, '/'),
    { dir: '/', kind: 'file' }
  );
});

test('resolveMenuTarget：空白处 ⇒ 根目录', function () {
  assert.deepStrictEqual(R.resolveMenuTarget(null, '/r'), { dir: '/r', kind: 'blank' });
});

test('resolveMenuTarget：⚠️ 灰显（ignored）行 ⇒ null——⛔ 关掉入口不等于后端放行', function () {
  assert.strictEqual(
    R.resolveMenuTarget({ path: '/r/node_modules', isDir: true, ignored: true }, '/r'),
    null
  );
});

// ── C.2 输入行按键语义（含中文组合态） ──────────────────────────────

test('inputAction：Enter ⇒ submit', function () {
  assert.strictEqual(R.inputAction({ key: 'Enter' }), 'submit');
});

test('inputAction：Escape ⇒ cancel', function () {
  assert.strictEqual(R.inputAction({ key: 'Escape' }), 'cancel');
});

test('inputAction：其他键 ⇒ ignore', function () {
  assert.strictEqual(R.inputAction({ key: 'a' }), 'ignore');
  assert.strictEqual(R.inputAction({ key: 'Tab' }), 'ignore');
  assert.strictEqual(R.inputAction(null), 'ignore');
});

test('inputAction：⚠️⚠️ 组合态（isComposing）下的 Enter ⇒ composing，⛔ 不是 submit', function () {
  assert.strictEqual(
    R.inputAction({ key: 'Enter', isComposing: true }),
    'composing'
  );
});

test('inputAction：⚠️⚠️ keyCode 229 也算组合态（有些 WebKit 不给 isComposing）', function () {
  assert.strictEqual(R.inputAction({ key: 'Enter', keyCode: 229 }), 'composing');
  assert.strictEqual(R.inputAction({ key: 'Escape', keyCode: 229 }), 'composing');
});

test('inputAction：组合态判在"键是不是 Enter/Escape"之后（别的键照旧 ignore）', function () {
  assert.strictEqual(
    R.inputAction({ key: 'a', isComposing: true, keyCode: 229 }),
    'ignore'
  );
});

// ── 错误文案映射（只有翻译，⛔ 没有规则判断） ─────────────────────────

const DICT = {
  'err.name.empty': '名字不能为空',
  'err.name.too-long': '名字太长',
  'err.kind.other': '操作失败',
  // ⭐ `design/0035`：改名被拒的三个 reason（键集合在 `i18n.js` 里一一对应）
  'err.rename.symlink': '符号链接不能改名',
  'err.rename.not_markdown': '只能重命名 Markdown 文件',
  'err.rename.editing': '正在编辑，先退出编辑再改名',
};

/** 与 `i18n.js` 的 `t()` 同形：查不到就退回 key 本身。 */
function fakeT(key) {
  return Object.prototype.hasOwnProperty.call(DICT, key) ? DICT[key] : key;
}

test('errorText：invalid_name + 已知 reason ⇒ 翻成人话', function () {
  assert.strictEqual(
    R.errorText({ kind: 'invalid_name', raw: { reason: 'empty' } }, fakeT),
    '名字不能为空'
  );
});

test('errorText：⚠️ 未知 reason ⇒ 退回 `wording`，⛔ 不印出 key', function () {
  assert.strictEqual(
    R.errorText(
      { kind: 'invalid_name', raw: { reason: 'brand-new' }, wording: '这个名字不能用' },
      fakeT
    ),
    '这个名字不能用'
  );
});

test('errorText：没有 raw ⇒ 用 wording（后端给的整句）', function () {
  assert.strictEqual(R.errorText({ wording: '没有权限' }, fakeT), '没有权限');
});

test('errorText：只有 message ⇒ 用 message', function () {
  assert.strictEqual(R.errorText({ message: 'boom' }, fakeT), 'boom');
});

test('errorText：什么都没有 ⇒ `err.kind.other`', function () {
  assert.strictEqual(R.errorText({}, fakeT), '操作失败');
  assert.strictEqual(R.errorText({ kind: 'denied' }, fakeT), '操作失败');
});

test('errorText：⛔ 别的 kind 即使带 reason 也不查 `err.name.*`', function () {
  assert.strictEqual(
    R.errorText({ kind: 'io', raw: { reason: 'empty' } }, fakeT),
    '操作失败'
  );
});

test('errorText：空错误对象 ⇒ 空串；没有翻译器也⛔ 不抛', function () {
  assert.strictEqual(R.errorText(null, fakeT), '');
  // ⚠️ 没有翻译器 ⇒ `t` 退回"原样返回 key"⇒ 连 `err.name.*` 也查不到
  // ⇒ 落到兜底那句（`err.kind.other`）。⛔ 不回退成裸 key 印在界面上。
  assert.strictEqual(
    R.errorText({ kind: 'invalid_name', raw: { reason: 'empty' } }),
    'err.kind.other'
  );
});

// ── `design/0035` §2.1：复制绝对路径的目标 ─────────────────────────────
//
// ⚠️ 错法**每次右键空白处都会踩到**：`hit.ignored` 写在 `!hit` 之前就是空引用。

test('copyTarget：⚠️ 空白处（`hit === null`）⇒ null，⛔ 不许抛', function () {
  assert.strictEqual(R.copyTarget(null, '/root'), null);
});

test('copyTarget：没有根（空会话 / 灰显行）⇒ 不出这一项', function () {
  assert.strictEqual(R.copyTarget({ path: '/root/a.md', isDir: false }, null), null);
  assert.strictEqual(R.copyTarget({ path: '/root/a.md', isDir: false, ignored: true }, '/root'), null);
});

test('copyTarget：文件行 ⇒ 路径原样（不拼、不转义、不裁）', function () {
  assert.strictEqual(
    R.copyTarget({ path: '/root/a.md', isDir: false }, '/root'),
    '/root/a.md'
  );
});

test('copyTarget：目录行**也有**这一项（§2.1：文件与目录都复制）', function () {
  assert.strictEqual(R.copyTarget({ path: '/root/sub', isDir: true }, '/root'), '/root/sub');
});

test('copyTarget：⚠️ 路径逐字节——空格 / 中文 / 引号 / 尾随空格都不许动', function () {
  // 用户的判据是"粘到终端里能不能直接用"（§2.1）⇒ 加引号或 trim 都是**改内容**
  const weird = '/root/有空 格 /a "b" \'c\'.md ';
  assert.strictEqual(R.copyTarget({ path: weird, isDir: false }, '/root'), weird);
});

test('copyTarget：路径缺失 ⇒ null（⛔ 不复制一个空串）', function () {
  assert.strictEqual(R.copyTarget({ path: '', isDir: false }, '/root'), null);
  assert.strictEqual(R.copyTarget({ isDir: false }, '/root'), null);
});

// ── `design/0035` §3.1：重命名的目标 ──────────────────────────────────

test('renameTarget：只有**文件行**有这一项（目录 / 空白 / 灰显 / 没根 ⇒ null）', function () {
  assert.strictEqual(R.renameTarget({ path: '/root/d', isDir: true }, '/root'), null);
  assert.strictEqual(R.renameTarget(null, '/root'), null);
  assert.strictEqual(R.renameTarget({ path: '/root/a.md', isDir: false, ignored: true }, '/root'), null);
  assert.strictEqual(R.renameTarget({ path: '/root/a.md', isDir: false }, null), null);
});

test('renameTarget：普通文件行 ⇒ 可用', function () {
  assert.deepStrictEqual(
    R.renameTarget({ path: '/root/a.md', isDir: false }, '/root', { editing: false, current: null }),
    { path: '/root/a.md', disabled: false }
  );
});

test('renameTarget：⚠️ 当前文档 ＋ 编辑态 ⇒ 置灰，**干净也算**（⛔ 不看 dirty）', function () {
  // 设计口径是"当前文档在编辑态下不许改名"，⛔ 不是"有未保存改动才不许"——
  // 干净缓冲区同样会被 `drop_watch()` 清掉编辑状态（§3.4）。
  const hit = { path: '/root/a.md', isDir: false };
  assert.deepStrictEqual(
    R.renameTarget(hit, '/root', { editing: true, current: '/root/a.md', dirty: false }),
    { path: '/root/a.md', disabled: true, reason: 'editing' }
  );
});

test('renameTarget：⚠️ 编辑态只挡**当前文档**——别的文件照常可改', function () {
  assert.deepStrictEqual(
    R.renameTarget({ path: '/root/b.md', isDir: false }, '/root', { editing: true, current: '/root/a.md' }),
    { path: '/root/b.md', disabled: false }
  );
});

test('renameTarget：没在编辑 ⇒ 当前文档也能改', function () {
  assert.deepStrictEqual(
    R.renameTarget({ path: '/root/a.md', isDir: false }, '/root', { editing: false, current: '/root/a.md' }),
    { path: '/root/a.md', disabled: false }
  );
});

test('renameTarget：没给状态 ⇒ 按"不在编辑"算（⛔ 不许抛）', function () {
  assert.deepStrictEqual(
    R.renameTarget({ path: '/root/a.md', isDir: false }, '/root'),
    { path: '/root/a.md', disabled: false }
  );
});

// ── `design/0035` §3.2：输入行的预填与选区 ────────────────────────────

test('baseName：最后一段；根 ⇒ 空串', function () {
  assert.strictEqual(R.baseName('/a/b.md'), 'b.md');
  assert.strictEqual(R.baseName('/'), '');
  assert.strictEqual(R.baseName('x'), 'x');
});

test('selectStem：只选主名，后缀留在选区外（§3.2）', function () {
  assert.deepStrictEqual(R.selectStem('note.md'), { start: 0, end: 4 });
});

test('selectStem：⚠️ 按**最后**一个点切（`a.b.md` ⇒ 选 `a.b`）', function () {
  assert.deepStrictEqual(R.selectStem('a.b.md'), { start: 0, end: 3 });
});

test('selectStem：没有点 / 以点开头 ⇒ 全选（⛔ 不返回空选区）', function () {
  assert.deepStrictEqual(R.selectStem('README'), { start: 0, end: 6 });
  assert.deepStrictEqual(R.selectStem('.gitignore'), { start: 0, end: 10 });
  assert.deepStrictEqual(R.selectStem(''), { start: 0, end: 0 });
});

// ── `design/0035` §3.5 / §2.4：降级与失败的文案键 ─────────────────────

test('degradedKeys：两个标签各自映射到一个**字面量**键', function () {
  assert.deepStrictEqual(R.degradedKeys(['watch']), ['tree.rename.degraded.watch']);
  assert.deepStrictEqual(R.degradedKeys(['path_check']), ['tree.rename.degraded.path_check']);
});

test('degradedKeys：两个都有 ⇒ 按后端给的顺序各一句', function () {
  assert.deepStrictEqual(
    R.degradedKeys(['watch', 'path_check']),
    ['tree.rename.degraded.watch', 'tree.rename.degraded.path_check']
  );
});

test('degradedKeys：⚠️ 未知标签丢掉（⛔ 拼一个没登记的键），非数组 ⇒ 空', function () {
  assert.deepStrictEqual(R.degradedKeys(['watch', 'brand-new']), ['tree.rename.degraded.watch']);
  assert.deepStrictEqual(R.degradedKeys(null), []);
  assert.deepStrictEqual(R.degradedKeys('watch'), []);
});

// ── `design/0035` §10.6 P2：重列完成那一刻的高亮判据 ────────────────────

test('highlightRenamed：重列完成时当前文档**就是**新路径 ⇒ 挂高亮', function () {
  assert.strictEqual(R.highlightRenamed('/rootA/b.md', '/rootA/b.md'), true);
});

test('highlightRenamed：⚠️ 重列期间用户打开了另一份文档 ⇒ ⛔ 不能把旧文档的新名字点亮', function () {
  // 这正是 §10.6 P2 的场景③：改名回包说"当前文档跟着动了"，
  // 但从回包到重列完成之间已经 `await` 过若干次，正文早就换成 B 了。
  assert.strictEqual(R.highlightRenamed('/rootA/other.md', '/rootA/b.md'), false);
});

test('highlightRenamed：没有当前文档 / 没有新路径 ⇒ 不点亮（⛔ 不拿空值互相相等）', function () {
  assert.strictEqual(R.highlightRenamed(null, '/rootA/b.md'), false);
  assert.strictEqual(R.highlightRenamed('/rootA/b.md', null), false);
  assert.strictEqual(R.highlightRenamed('', ''), false);
});

test('源码闸门：`afterRename` 的高亮走 `highlightRenamed`，⛔ 不看历史 `current_moved`', function () {
  // ⚠️ 纯函数测过不算接线对：组件里若退回 `if (res.current_moved) setCurrent(...)`，
  //    场景「重列期间用户打开了 B」又会把 A 点亮（`design/0035` §10.6 P2）。
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'src', 'components', 'FileTree.js'), 'utf8')
  );
  assert.ok(
    src.indexOf('R.highlightRenamed(S.state.currentPath, res.path)') >= 0,
    'afterRename 必须按**重列完成那一刻**的 S.state.currentPath 决定高亮'
  );
  assert.strictEqual(
    /if\s*\(\s*res\.current_moved\s*\)\s*setCurrent/.test(src),
    false,
    '⛔ 不许用回包里的历史 current_moved 直接点亮'
  );
});

test('copyFailKey：三类失败各有一句；⚠️ 未知 reason 落到"复制失败"', function () {
  assert.strictEqual(R.copyFailKey('unsupported'), 'tree.copy.unsupported');
  assert.strictEqual(R.copyFailKey('denied'), 'tree.copy.denied');
  assert.strictEqual(R.copyFailKey('failed'), 'tree.copy.failed');
  assert.strictEqual(R.copyFailKey('brand-new'), 'tree.copy.failed');
  assert.strictEqual(R.copyFailKey(undefined), 'tree.copy.failed');
});

test('errorText：not_renamable + 已知 reason ⇒ 翻成人话（⛔ 不自己再判一遍规则）', function () {
  assert.strictEqual(
    R.errorText({ kind: 'not_renamable', raw: { reason: 'symlink' } }, fakeT),
    '符号链接不能改名'
  );
  assert.strictEqual(
    R.errorText({ kind: 'not_renamable', raw: { reason: 'editing' } }, fakeT),
    '正在编辑，先退出编辑再改名'
  );
});

test('errorText：not_renamable + 未知 reason ⇒ 退回 `wording`（⛔ 印裸 key）', function () {
  assert.strictEqual(
    R.errorText({ kind: 'not_renamable', raw: { reason: 'brand-new' }, wording: '这个文件不能改名' }, fakeT),
    '这个文件不能改名'
  );
});

// ── 源码级闸门：加载顺序（`index.html` 里本模块必须先于 FileTree.js） ──

test('源码闸门：treerefresh.js 必须先于 FileTree.js 被加载', function () {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const a = html.indexOf('src="services/treerefresh.js"');
  const b = html.indexOf('src="components/FileTree.js"');
  assert.ok(a >= 0, 'index.html 里没有 services/treerefresh.js');
  assert.ok(b >= 0, 'index.html 里没有 components/FileTree.js');
  assert.ok(a < b, '⚠️ 顺序反了：FileTree.js 在加载期取 window.rmd.treeRefresh，' +
    '排在它后面时是 undefined——第一次刷新或第一次右键才炸');
});

test('源码闸门：FileTree.js 在加载期取的正是本模块', function () {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'components', 'FileTree.js'), 'utf8');
  assert.match(src, /window\.rmd\.treeRefresh/);
});

// ── 源码级闸门：三条清单必须同批（`design/0034` §7.1 / §1.4 #16） ─────
//
// ⚠️ 这条闸门守的失效形态是**静默**的：`#[tauri::command]` 写好了、前端也调了，
//    但只要 `build.rs` 的 `AppManifest::commands(..)` 或 `capabilities/default.json`
//    漏一条，ACL 会**直接拒**（`docs/bugs/0002` 同族），而且不报错。
// ⭐ 裸判据 `三处都在()` 单独抽出来，配**四格自测**——免得哪天有人把扫描范围
//    改窄成"只扫 `gui/mod.rs`"而闸门**照样全绿**（`tests.md` ⑨ 的写法）。

/** camelCase / snake_case ⇒ kebab-case（Tauri 的权限 id 是 kebab）。 */
function kebab(cmd) {
  return cmd
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/** 裸判据：三份源码里**各自**能不能看到这个命令。⛔ 不读文件，只吃字符串。 */
function 三处都在(buildRs, capsJson, handlerSrc, cmd) {
  const perm = 'allow-' + kebab(cmd);
  let caps = { permissions: [] };
  try {
    caps = JSON.parse(capsJson);
  } catch (e) {
    return { build: false, caps: false, handler: false, error: 'json: ' + e.message };
  }
  const perms = caps.permissions || [];
  return {
    build: buildRs.indexOf('"' + cmd + '"') >= 0,
    caps: perms.indexOf(perm) >= 0,
    handler: new RegExp('\\b' + cmd + '\\b').test(handlerSrc),
  };
}

test('裸判据自测：三处齐 ⇒ 全真；缺任一 ⇒ 那一格假', function () {
  const build = 'commands(&["a", "create_entry", "b"]).unwrap();';
  const caps = JSON.stringify({ permissions: ['allow-create-entry'] });
  const handler = 'tauri::generate_handler![fs_cmd::create_entry, other]';
  assert.deepStrictEqual(三处都在(build, caps, handler, 'create_entry'), {
    build: true, caps: true, handler: true,
  });
  assert.strictEqual(三处都在('commands(&["a"])', caps, handler, 'create_entry').build, false);
  assert.strictEqual(三处都在(build, JSON.stringify({ permissions: [] }), handler, 'create_entry').caps, false);
  assert.strictEqual(三处都在(build, caps, 'generate_handler![other]', 'create_entry').handler, false);
});

test('裸判据自测：坏 JSON 不许抛，且三格都判假', function () {
  const r = 三处都在('"create_entry"', '{ nope', 'create_entry', 'create_entry');
  assert.strictEqual(r.build, false);
  assert.strictEqual(r.caps, false);
  assert.strictEqual(r.handler, false);
  assert.ok(r.error, '坏 JSON 要留下原因，⛔ 不许静默');
});

test('⭐ 三处清单一致性：`create_entry` 在 build.rs / capabilities / generate_handler 里都有', function () {
  const build = fs.readFileSync(path.join(ROOT, 'src-tauri', 'build.rs'), 'utf8');
  const caps = fs.readFileSync(path.join(ROOT, 'src-tauri', 'capabilities', 'default.json'), 'utf8');
  const handler = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'gui', 'mod.rs'), 'utf8');
  const r = 三处都在(build, caps, handler, 'create_entry');
  assert.deepStrictEqual(
    r,
    { build: true, caps: true, handler: true },
    '⚠️ 缺哪一处，ACL 就在哪一处**静默拒**——' + JSON.stringify(r)
  );
});

test('⭐ 三处清单一致性：`rename_entry` 在 build.rs / capabilities / generate_handler 里都有', function () {
  // ⚠️ `design/0035` §3.6：与 `create_entry` 同一条纪律——
  //    少一处 ACL 就**静默拒**，而右键菜单看起来完全正常。
  const build = fs.readFileSync(path.join(ROOT, 'src-tauri', 'build.rs'), 'utf8');
  const caps = fs.readFileSync(path.join(ROOT, 'src-tauri', 'capabilities', 'default.json'), 'utf8');
  const handler = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'gui', 'mod.rs'), 'utf8');
  const r = 三处都在(build, caps, handler, 'rename_entry');
  assert.deepStrictEqual(
    r,
    { build: true, caps: true, handler: true },
    '⚠️ 缺哪一处，ACL 就在哪一处**静默拒**——' + JSON.stringify(r)
  );
});

// ── 源码级闸门：`FileTree.js` 里⛔ 不许出现第二份判据 ─────────────────
//
// ⚠️ 先**剥注释**再扫：文件头那段解释忽略清单的注释里写着 `node_modules`，
//    不剥的话这条闸门会对着说明文字变红（`design/0019` §2.2 同款坑）。

/** 剥掉块注释与行注释。⚠️ 只够用于**本仓库这种风格**的 JS，⛔ 不是通用词法器。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(function (l) { return l.replace(/\/\/.*$/, ''); })
    .join('\n');
}

test('裸判据：剥注释自测（注释里的字面量不许算命中）', function () {
  const src = '/* 忽略清单里的 node_modules */\nvar a = 1; // node_modules\nvar b = "x";';
  const s = stripComments(src);
  assert.strictEqual(s.indexOf('node_modules'), -1);
  assert.ok(s.indexOf('var a = 1;') >= 0, '注释之外的内容不许被吃掉');
});

test('⛔ FileTree.js 里没有第二份名字规则（`node_modules` / `.md` 后缀 / `..`）', function () {
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'src', 'components', 'FileTree.js'), 'utf8')
  );
  // ⚠️ 三条口径，都是被实测逼出来的：
  //    ① `/` 不能禁——路径拼接到处都要它；
  //    ② 光秃秃的 `..` 不能禁——`require('../services/x.js')` 里到处都是；
  //    ③ 所以判据取**带引号的字面量**：名字规则若被抄到前端，形态只可能是
  //       `name === '..'` / `name.indexOf('..')` / `endsWith('.md')` 这三种。
  assert.strictEqual(src.indexOf('node_modules'), -1,
    '忽略清单是后端 `fs/tree.rs` 的真值，前端 ⛔ 不另判一份（`INV-TREE-07`）');
  assert.strictEqual(src.indexOf("'.md'"), -1,
    '`.md` 后缀由 `fs::create::validate_name` 补，前端 ⛔ 不拼');
  assert.strictEqual(src.indexOf('".md"'), -1,
    '`.md` 后缀由 `fs::create::validate_name` 补，前端 ⛔ 不拼');
  assert.strictEqual(src.indexOf("'..'"), -1,
    '`..` 的拒绝也在后端闸门里，前端 ⛔ 不写第二份');
  assert.strictEqual(src.indexOf('".."'), -1,
    '`..` 的拒绝也在后端闸门里，前端 ⛔ 不写第二份');
});

test('裸判据自测：上面那五条口径能抓到"最省事的那种抄法"', function () {
  const 坏 = stripComments([
    "if (name === '..' || name.indexOf('/') >= 0) return 'invalid_name';",
    "if (name.endsWith('.md')) name = name;",
    "if (IGNORED.indexOf('node_modules') >= 0) return;",
  ].join('\n'));
  assert.strictEqual(坏.indexOf('node_modules') >= 0, true);
  assert.strictEqual(坏.indexOf("'..'") >= 0, true);
  assert.strictEqual(坏.indexOf("'.md'") >= 0, true);
});

test('⛔ FileTree.js 里不出现 `latestTreeReq`（防止换回全局序号）', function () {
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'src', 'components', 'FileTree.js'), 'utf8')
  );
  assert.strictEqual(src.indexOf('latestTreeReq'), -1,
    '按路径发号（`treerefresh.js::nextSeq`）是父子并发的唯一防线；' +
    '换回一个全局计数器会让正常并发互相判死（§2.1 A.2）');
});

// ── 源码级闸门：`design/0035` 的接线（剪贴板只一条路 / 编辑态由外面注入） ──

test('源码闸门：clipboard.js 必须先于 FileTree.js 被加载', function () {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const a = html.indexOf('src="services/clipboard.js"');
  const b = html.indexOf('src="components/FileTree.js"');
  assert.ok(a >= 0, 'index.html 里没有 services/clipboard.js');
  assert.ok(b >= 0, 'index.html 里没有 components/FileTree.js');
  assert.ok(a < b, '⚠️ 顺序反了：FileTree.js 在加载期取 window.rmd.clipboard，' +
    '排在它后面时是 undefined——第一次点「复制绝对路径」才炸');
});

test('⛔ FileTree.js 里没有第二份剪贴板写入（`navigator.clipboard` / `execCommand`）', function () {
  // ⚠️ 判据是"写入实现只有一份"（§2.3）：组件里再写一条，两条路的失败形态不同，
  //    "到底走哪条"就变成运行期随机，而屏幕上看不出来。
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'src', 'components', 'FileTree.js'), 'utf8')
  );
  assert.strictEqual(src.indexOf('navigator.clipboard'), -1,
    '写入只许在 services/clipboard.js 里（INV-CLIP 一族的"唯一实现"）');
  assert.strictEqual(src.indexOf('execCommand'), -1,
    '写入只许在 services/clipboard.js 里（INV-CLIP 一族的"唯一实现"）');
});

test('源码闸门：编辑态由 `main.js` 注入给文件树（`getEditorState`）', function () {
  // ⚠️ `treerefresh.js::renameTarget` 只吃 `{editing, current}`；树自己**不持有**编辑状态
  //    （那是 `session.js` 的真值）。注入口丢了，当前文档在编辑态下会**悄悄可改名**，
  //    而唯一的兜底只剩后端那一下。
  const tree = stripComments(
    fs.readFileSync(path.join(ROOT, 'src', 'components', 'FileTree.js'), 'utf8')
  );
  const main = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8'));
  assert.ok(tree.indexOf('getEditorState') >= 0, 'FileTree.js 没读 opts.getEditorState');
  assert.match(main, /getEditorState\s*:/, 'main.js 建树时没注入 getEditorState');
});
