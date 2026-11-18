// diskevents 的缺陷回归用例（`tests/auto/js/bugs-services-b/`）。
//
// 覆盖：目录事件原样到达时的 seq 推进、重复/倒退包合并、健康档映射、
// 两条 IPC 的调用与回包采纳。所有用例只读源码并喂纯对象，不碰 Tauri。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadDiskEvents() {
  const win = {};
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'diskevents.js'), 'utf8');
  new Function('window', src)(win);
  return win.rmd.diskEvents;
}

const DE = loadDiskEvents();

test.beforeEach(function () { DE._reset(); });

function view(over) {
  return Object.assign({ epoch: 0, watch_id: 1, revision: 1, reason: null, pending: false }, over || {});
}

/** 静默掉产品里的 console.error，返回它收到的日志。 */
function silenceError(fn) {
  const old = console.error;
  const logs = [];
  console.error = function () { logs.push([].slice.call(arguments).join(' ')); };
  try {
    return { value: fn(), logs: logs };
  } finally {
    console.error = old;
  }
}

// ── 事件名是跨语言契约 ──────────────────────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('两条事件名与 Rust 侧逐字一致，拼错就收不到任何磁盘变化', () => {
  assert.strictEqual(DE.TREE_EVENT, 'rmd://tree-changed');
  assert.strictEqual(DE.DISK_EVENT, 'rmd://dir-watch');
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('树事件到达时 seq 同步 +1，调用方在提交点就能看见「这个时刻已经过去」', () => {
  assert.strictEqual(DE.seq(), 0);
  assert.strictEqual(DE.bump(), 1);
  assert.strictEqual(DE.seq(), 1);
  assert.strictEqual(DE.bump(), 2);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('两条树事件各推一格，不做去抖合并（合并发生在后端）', () => {
  const got = [];
  DE.onChange(function (s) { got.push(s); });
  DE.bump();
  DE.bump();
  assert.deepStrictEqual(got, [1, 2]);
});

// ── DiskView 采纳：重复与倒退必须丢弃 ──────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('shouldAccept 第一份永远采纳，之后必须 revision 严格更大', () => {
  assert.strictEqual(DE.shouldAccept(null, view({ revision: 1 })), true);
  assert.strictEqual(DE.shouldAccept(view({ revision: 1 }), view({ revision: 2 })), true);
  assert.strictEqual(DE.shouldAccept(view({ revision: 2 }), view({ revision: 2 })), false);
  assert.strictEqual(DE.shouldAccept(view({ revision: 5 }), view({ revision: 4 })), false);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('shouldAccept 只认 typeof number，字符串 revision 不算数', () => {
  assert.strictEqual(DE.shouldAccept(null, { revision: '1' }), false);
  assert.strictEqual(DE.shouldAccept(null, { revision: null }), false);
  assert.strictEqual(DE.shouldAccept(null, {}), false);
  assert.strictEqual(DE.shouldAccept(null, null), false);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('shouldAccept 对 NaN revision 仍然采纳（typeof NaN 是 number）', () => {
  // ⚠️ 疑似缺陷：NaN 能穿过形状校验，并让后续所有有限 revision 都被判成倒退。
  assert.strictEqual(DE.shouldAccept(null, { revision: NaN }), true);
  assert.strictEqual(DE.shouldAccept({ revision: NaN }, { revision: 9 }), false);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('重复的 DiskView 被丢弃：状态、seq、健康订阅者都不动', () => {
  DE.adopt(view({ revision: 2, epoch: 3 }));
  const before = DE.state();
  const states = [];
  DE.onState(function (v) { states.push(v); });
  assert.strictEqual(DE.adopt(view({ revision: 2, epoch: 9 })), false);
  assert.strictEqual(DE.state(), before);
  assert.strictEqual(DE.seq(), 1, '第一份 epoch 0→3 推了一格，重复包不该再推');
  assert.deepStrictEqual(states, []);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('倒退的 DiskView 被丢弃，迟到包不会把恢复重新写成降级', () => {
  DE.adopt(view({ revision: 5, reason: 'io' }));
  DE.adopt(view({ revision: 6, reason: null }));
  assert.strictEqual(DE.adopt(view({ revision: 4, reason: 'io' })), false);
  assert.strictEqual(DE.state().revision, 6);
  assert.strictEqual(DE.state().reason, null);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('adopt 采纳恢复包（reason 为 null）——那是撤掉提示的唯一信号', () => {
  const got = [];
  DE.onState(function (v) { got.push(v.reason); });
  DE.adopt(view({ revision: 1, reason: 'limit' }));
  DE.adopt(view({ revision: 2, reason: null }));
  assert.deepStrictEqual(got, ['limit', null]);
});

// ── epoch 与 seq：内容前进 vs 纯健康变化 ───────────────────────────

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('初值 epoch=0 的第一份 DiskView 不白推 seq（否则启动就多一次重列）', () => {
  DE.adopt(view({ revision: 1, epoch: 0 }));
  assert.strictEqual(DE.seq(), 0);
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('epoch 前进一格只推一格 seq，哪怕跳了很远', () => {
  DE.adopt(view({ revision: 1, epoch: 1 }));
  assert.strictEqual(DE.seq(), 1);
  DE.adopt(view({ revision: 2, epoch: 1000 }));
  assert.strictEqual(DE.seq(), 2);
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('纯健康变化（epoch 不变）不推 seq，避免监视抖一下就白重列', () => {
  DE.adopt(view({ revision: 1, epoch: 7 }));
  assert.strictEqual(DE.seq(), 1);
  DE.adopt(view({ revision: 2, epoch: 7, reason: 'rescan' }));
  assert.strictEqual(DE.seq(), 1);
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('epoch 倒退也推 seq：它表示盘上的时刻变了，不等于没变', () => {
  DE.adopt(view({ revision: 1, epoch: 5 }));
  DE.adopt(view({ revision: 2, epoch: 3 }));
  assert.strictEqual(DE.seq(), 2);
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('adopt 前进 epoch 时不通知内容订阅者，重列另有落点', () => {
  const changed = [];
  DE.onChange(function (s) { changed.push(s); });
  DE.adopt(view({ revision: 1, epoch: 3 }));
  assert.strictEqual(DE.seq(), 1);
  assert.deepStrictEqual(changed, []);
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('epoch 是 NaN 时每次采纳都推 seq（NaN !== 任何数）', () => {
  // ⚠️ 疑似缺陷：NaN epoch 被当成「变了」，一次畸形包之后 seq 会持续被推。
  DE.adopt(view({ revision: 1, epoch: NaN }));
  assert.strictEqual(DE.seq(), 1);
  DE.adopt(view({ revision: 2, epoch: NaN }));
  assert.strictEqual(DE.seq(), 2);
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('epoch 缺失或非数字时不推 seq', () => {
  DE.adopt(view({ revision: 1, epoch: undefined }));
  DE.adopt(view({ revision: 2, epoch: '5' }));
  assert.strictEqual(DE.seq(), 0);
});

// ── 健康档映射 ──────────────────────────────────────────────────────

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('rescan 是临时档：不给重试按钮，自己会好', () => {
  assert.deepStrictEqual(DE.healthOf({ reason: 'rescan' }), {
    key: 'disk.rescan', retry: false, transient: true,
  });
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('四个持久档各映射到自己的键，都可重试且非临时', () => {
  assert.deepStrictEqual(DE.healthOf({ reason: 'io' }), {
    key: 'disk.io', retry: true, transient: false,
  });
  assert.deepStrictEqual(DE.healthOf({ reason: 'path-not-found' }), {
    key: 'disk.path-not-found', retry: true, transient: false,
  });
  assert.deepStrictEqual(DE.healthOf({ reason: 'limit' }), {
    key: 'disk.limit', retry: true, transient: false,
  });
  assert.deepStrictEqual(DE.healthOf({ reason: 'rewatch-failed' }), {
    key: 'disk.rewatch-failed', retry: true, transient: false,
  });
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('未知档照实显示空 key，⛔ 不静默成「没事」', () => {
  assert.deepStrictEqual(DE.healthOf({ reason: 'not-a-real-kind' }), {
    key: '', retry: true, transient: false,
  });
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('没有原因时什么都不显示：null / 空串 / 0 都算没有', () => {
  assert.strictEqual(DE.healthOf(null), null);
  assert.strictEqual(DE.healthOf({}), null);
  assert.strictEqual(DE.healthOf({ reason: '' }), null);
  assert.strictEqual(DE.healthOf({ reason: 0 }), null);
});

// 源自 docs/bugs/0039（核对失败之后后台线程一直空转）
test('healthOf 的 retry 由档位决定，不信任载荷自己带来的 retry 字段', () => {
  assert.deepStrictEqual(DE.healthOf({ reason: 'rescan', retry: true }), {
    key: 'disk.rescan', retry: false, transient: true,
  });
  assert.deepStrictEqual(DE.healthOf({ reason: 'io', retry: false }), {
    key: 'disk.io', retry: true, transient: false,
  });
});

// ── 两条 IPC 与回包采纳 ─────────────────────────────────────────────

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('install 订阅两条通道，任何一条失败都要在 note 里说出来', async () => {
  const T = {
    listen: function (name) {
      if (name === DE.TREE_EVENT) throw new Error('tree down');
      return Promise.resolve();
    },
  };
  const r = await DE.install(T);
  assert.deepStrictEqual(r, { treeOk: false, diskOk: true, note: 'tree:tree down' });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('install 两条都失败时用分号连接，wording 形状的错误也能读出来', async () => {
  const T = {
    listen: function (name) {
      if (name === DE.TREE_EVENT) throw new Error('tree down');
      throw { wording: 'disk down' };
    },
  };
  const r = await DE.install(T);
  assert.deepStrictEqual(r, {
    treeOk: false, diskOk: false, note: 'tree:tree down; disk:disk down',
  });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('install 失败之后再次 install 直接报成功，不再重试订阅', async () => {
  // ⚠️ 疑似缺陷：installed 在尝试订阅前就置 true，失败的通道永远没有第二次机会。
  let listens = 0;
  const bad = { listen: function () { listens += 1; throw new Error('down'); } };
  const first = await DE.install(bad);
  assert.deepStrictEqual(first.treeOk, false);
  const second = await DE.install({ listen: async function () { listens += 1; } });
  assert.deepStrictEqual(second, { treeOk: true, diskOk: true, note: '' });
  assert.strictEqual(listens, 2, '第二次没有重新订阅任何通道');
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('install 成功后重复调用不重复订阅，返回成功', async () => {
  let listens = 0;
  const T = { listen: async function () { listens += 1; } };
  await DE.install(T);
  const r = await DE.install(T);
  assert.strictEqual(listens, 2);
  assert.deepStrictEqual(r, { treeOk: true, diskOk: true, note: '' });
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('树通道回调同步推 seq，磁盘通道回调采纳 payload', async () => {
  const handlers = {};
  const T = { listen: async function (name, fn) { handlers[name] = fn; } };
  await DE.install(T);
  handlers[DE.TREE_EVENT]();
  assert.strictEqual(DE.seq(), 1);
  handlers[DE.DISK_EVENT]({ payload: view({ revision: 3, epoch: 0 }) });
  assert.strictEqual(DE.state().revision, 3);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('磁盘事件没有 payload 时不动状态，也不抛', async () => {
  const handlers = {};
  const T = { listen: async function (name, fn) { handlers[name] = fn; } };
  await DE.install(T);
  assert.doesNotThrow(function () { handlers[DE.DISK_EVENT](undefined); });
  assert.strictEqual(DE.state(), null);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('refresh 只调 reconcile_disk，采纳回包并返回原值', async () => {
  const calls = [];
  const v = view({ revision: 3, epoch: 4 });
  const T = { call: async function (name) { calls.push(name); return v; } };
  const got = await DE.refresh(T);
  assert.deepStrictEqual(calls, ['reconcile_disk']);
  assert.strictEqual(got, v);
  assert.strictEqual(DE.state(), v);
  assert.strictEqual(DE.seq(), 1);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('refresh 回包为空时不采纳也不抛', async () => {
  const T = { call: async function () { return null; } };
  assert.strictEqual(await DE.refresh(T), null);
  assert.strictEqual(DE.state(), null);
  assert.strictEqual(DE.seq(), 0);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('refresh 的回包比当前更旧时仍原样返回，但状态不被覆盖', async () => {
  DE.adopt(view({ revision: 5, epoch: 0 }));
  const older = view({ revision: 4, epoch: 99 });
  const got = await DE.refresh({ call: async function () { return older; } });
  assert.strictEqual(got, older);
  assert.strictEqual(DE.state().revision, 5);
});

// 源自 docs/bugs/0088（三条命令的IPC参数键写成snake_case导致静默失败）
test('retryWatch 只调 retry_tree_watch，并采纳回包推 seq（盲窗口里盘上可能变过）', async () => {
  const calls = [];
  const v = view({ revision: 1, epoch: 2 });
  const T = { call: async function (name) { calls.push(name); return v; } };
  const got = await DE.retryWatch(T);
  assert.deepStrictEqual(calls, ['retry_tree_watch']);
  assert.strictEqual(got, v);
  assert.strictEqual(DE.state(), v);
  assert.strictEqual(DE.seq(), 1);
});

// ── 订阅者隔离与复位 ────────────────────────────────────────────────

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('一个内容订阅者抛错不挡住另一个，退订后不再收到', () => {
  const old = console.error;
  console.error = function () {};
  try {
    const got = [];
    const off = DE.onChange(function () { throw new Error('树消费者坏了'); });
    DE.onChange(function (s) { got.push(s); });
    DE.bump();
    off();
    DE.bump();
    assert.deepStrictEqual(got, [1, 2]);
  } finally {
    console.error = old;
  }
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('一个状态订阅者抛错不挡住另一个', () => {
  const old = console.error;
  console.error = function () {};
  try {
    const got = [];
    DE.onState(function () { throw new Error('状态条坏了'); });
    DE.onState(function (v) { got.push(v.revision); });
    DE.adopt(view({ revision: 1 }));
    DE.adopt(view({ revision: 2 }));
    assert.deepStrictEqual(got, [1, 2]);
  } finally {
    console.error = old;
  }
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('非函数订阅是安全的空操作，返回可调用的退订函数', () => {
  assert.doesNotThrow(function () { DE.onChange(null)(); });
  assert.doesNotThrow(function () { DE.onState('nope')(); });
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('_reset 清空 seq、状态、订阅表与安装标记', async () => {
  const got = [];
  DE.onChange(function (s) { got.push(s); });
  DE.adopt(view({ revision: 1, epoch: 1 }));
  let listens = 0;
  await DE.install({ listen: async function () { listens += 1; } });

  DE._reset();
  assert.strictEqual(DE.seq(), 0);
  assert.strictEqual(DE.state(), null);
  DE.bump();
  assert.deepStrictEqual(got, [], '旧订阅者必须已被清掉');

  await DE.install({ listen: async function () { listens += 1; } });
  assert.strictEqual(listens, 4, '_reset 之后允许重新安装两条通道');
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('bump 通知的是当前 DiskView，不只是空对象', () => {
  const seen = [];
  DE.onChange(function (s, v) { seen.push(v); });
  DE.adopt(view({ revision: 2 }));
  DE.bump();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].revision, 2);
});

// 源自 docs/bugs/0019（外部新增文件在目录树里不出现）
test('shouldAccept 不按「看起来更严重」合并：Io 之后的一版 null 也要看 revision', () => {
  assert.strictEqual(DE.shouldAccept({ revision: 8, reason: 'io' }, { revision: 9, reason: null }), true);
  assert.strictEqual(DE.shouldAccept({ revision: 8, reason: null }, { revision: 7, reason: 'io' }), false);
});
