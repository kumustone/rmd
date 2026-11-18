// 保存的唯一入口：单飞、发出时的文本 / 修订快照、失败不报已保存、清脏前重判修订。
// 守的是 `INV-EDIT-05/10` 与 `design/0012` §2.4；历史缺陷见 `bugs/0003`、`0067`、`0107`。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function loadSave(withI18n) {
  const win = {};
  if (withI18n) {
    win.rmd = {
      i18n: {
        t: function (key, params) {
          return params === undefined ? key : key + ' ' + JSON.stringify(params);
        },
      },
    };
  }
  const src = fs.readFileSync(path.join(ROOT, 'src/editor/save.js'), 'utf8');
  new Function('window', src)(win);
  return win.rmd.editorSave;
}

const S = loadSave(true);
const S_RAW = loadSave(false);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (res, rej) {
    resolve = res;
    reject = rej;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

function setup(over, api) {
  const o = over || {};
  const statuses = [];
  const cleans = [];
  const dones = [];
  const sends = [];
  const events = [];
  const counter = { getText: 0, rev: 0, mounted: 0, send: 0 };
  let text = o.text === undefined ? 'body' : o.text;
  let rev = o.rev === undefined ? 0 : o.rev;
  const saver = (api || S).createSaver({
    getText: function () {
      counter.getText++;
      events.push('getText');
      return typeof text === 'function' ? text() : text;
    },
    rev: function () {
      counter.rev++;
      events.push('rev');
      return typeof rev === 'function' ? rev() : rev;
    },
    send: function (txt) {
      counter.send++;
      events.push('send');
      sends.push(txt);
      if (o.send) return o.send(txt);
      return { written: true, bytes: txt.length, ms: 1.5 };
    },
    onStatus: function (s, isError) {
      statuses.push([s, isError]);
      events.push('status:' + (isError ? 'error' : 'ok'));
    },
    onClean: function () {
      cleans.push(1);
      events.push('clean');
    },
    onDone: o.noDone
      ? undefined
      : function (out) {
        dones.push(out);
        events.push('done');
      },
    isMounted: o.isMounted
      ? function () {
        counter.mounted++;
        events.push('mounted');
        return o.isMounted();
      }
      : undefined,
  });
  return {
    saver: saver,
    statuses: statuses,
    cleans: cleans,
    dones: dones,
    sends: sends,
    events: events,
    counter: counter,
    setText: function (v) { text = v; },
    setRev: function (v) { rev = v; },
  };
}

// ── 成功路径 ────────────────────────────────────────────────────────────
test('成功保存：saving → done（带字节与一位小数毫秒），清脏一次并交回 last', async () => {
  const a = setup();
  const out = await a.saver.save();
  assert.deepStrictEqual(a.statuses, [
    ['save.saving', false],
    ['save.done {"bytes":4,"ms":"1.5"}', false],
  ]);
  assert.deepStrictEqual(a.cleans, [1]);
  assert.strictEqual(a.saver.last(), out);
  assert.deepStrictEqual(a.dones, [out]);
  assert.deepStrictEqual(a.sends, ['body']);
  assert.strictEqual(a.saver.isInflight(), false);
});

test('written=false 用 no-change 文案，⛔ 不把它说成已保存', async () => {
  const a = setup({
    send: function () {
      return { written: false, bytes: 0, ms: 0.2 };
    },
  });
  const out = await a.saver.save();
  assert.strictEqual(out.written, false);
  assert.deepStrictEqual(a.statuses, [
    ['save.saving', false],
    ['save.no-change', false],
  ]);
  assert.deepStrictEqual(a.cleans, [1]);
});

test('written 缺省（不是严格的 false）仍按 done 报，不误判成 no-change', async () => {
  const a = setup({
    send: function () {
      return { bytes: 3, ms: 2 };
    },
  });
  await a.saver.save();
  assert.strictEqual(a.statuses[1][0], 'save.done {"bytes":3,"ms":"2.0"}');
});

test('written=false 时即便字节非零也只报 no-change（判据只看 written）', async () => {
  const a = setup({
    send: function () {
      return { written: false, bytes: 99, ms: 1 };
    },
  });
  await a.saver.save();
  assert.deepStrictEqual(a.statuses, [
    ['save.saving', false],
    ['save.no-change', false],
  ]);
});

test('成功文案的毫秒保留一位小数，字节用 0 兜底', async () => {
  const a = setup({
    send: function () {
      return { written: true, bytes: 0, ms: 12.345 };
    },
  });
  await a.saver.save();
  assert.strictEqual(a.statuses[1][0], 'save.done {"bytes":0,"ms":"12.3"}');
});

test('send 解析成 falsy 时按 0 字节 / 0 毫秒报 done，不崩', async () => {
  const a = setup({
    send: function () {
      return null;
    },
  });
  const out = await a.saver.save();
  assert.strictEqual(out, null);
  assert.strictEqual(a.statuses[1][0], 'save.done {"bytes":0,"ms":"0"}');
  assert.deepStrictEqual(a.cleans, [1]);
});

test('返回值就是 send 的结果本体，last 也是同一个引用', async () => {
  const payload = { written: true, bytes: 4, ms: 0 };
  const a = setup({
    send: function () {
      return payload;
    },
  });
  const out = await a.saver.save();
  assert.strictEqual(out, payload);
  assert.strictEqual(a.saver.last(), payload);
});

test('onDone 可以省略，保存照常成功', async () => {
  const a = setup({ noDone: true });
  const out = await a.saver.save();
  assert.strictEqual(out.written, true);
  assert.deepStrictEqual(a.cleans, [1]);
});

// ── 发出时刻的快照 ──────────────────────────────────────────────────────
test('发出的文本与修订都在发起那一刻同步取，send 拿到的是同一份', async () => {
  let seen = null;
  const a = setup({
    send: function (txt) {
      seen = txt;
      return { written: true, bytes: 3, ms: 1 };
    },
  });
  a.setText('abc');
  a.setRev(7);
  await a.saver.save();
  assert.strictEqual(seen, 'abc');
  assert.strictEqual(a.counter.getText, 1);
  assert.strictEqual(a.counter.rev, 2);
});

test('取文本与取修订之间没有 await：两个动作紧挨着发生', async () => {
  const a = setup();
  await a.saver.save();
  assert.deepStrictEqual(a.events.slice(0, 3), ['getText', 'rev', 'status:ok']);
  assert.strictEqual(a.events[3], 'send');
});

test('发送期间缓冲文本变了但修订没变：仍清脏（重判只看修订号）', async () => {
  let text = 'before';
  const a = setup({
    rev: function () { return 0; },
    send: function () {
      text = 'after';
      return { written: true, bytes: 6, ms: 1 };
    },
  });
  a.setText(function () { return text; });
  await a.saver.save();
  assert.deepStrictEqual(a.cleans, [1]);
  assert.deepStrictEqual(a.sends, ['before']);
});

// ── 单飞闸 ──────────────────────────────────────────────────────────────
test('单飞：在途时第二次 save 返回 null、只报 ignored，不发第二个请求', async () => {
  const gate = deferred();
  const a = setup({
    send: function () {
      return gate.promise;
    },
  });
  const first = a.saver.save();
  assert.strictEqual(a.saver.isInflight(), true);
  assert.strictEqual(await a.saver.save(), null);
  assert.deepStrictEqual(a.statuses, [
    ['save.saving', false],
    ['save.ignored', false],
  ]);
  const gets = a.counter.getText;
  gate.resolve({ written: true, bytes: 4, ms: 2 });
  await first;
  assert.strictEqual(a.sends.length, 1);
  assert.strictEqual(a.counter.getText, gets);
  assert.strictEqual(a.counter.rev, 2);
});

test('单飞：被忽略的第二次不取文本、不取修订，也不进 send', async () => {
  const gate = deferred();
  const a = setup({ send: function () { return gate.promise; } });
  const first = a.saver.save();
  await a.saver.save();
  assert.strictEqual(a.counter.send, 1);
  assert.strictEqual(a.counter.getText, 1);
  assert.strictEqual(a.counter.rev, 1);
  gate.resolve({ written: true, bytes: 4, ms: 1 });
  await first;
});

test('单飞闸在成功后复位，下一次保存照常发出', async () => {
  const a = setup();
  await a.saver.save();
  await a.saver.save();
  assert.deepStrictEqual(a.sends, ['body', 'body']);
  assert.strictEqual(a.saver.isInflight(), false);
});

test('单飞闸在 send 抛错时也由 finally 复位（finally 在 catch 之后）', async () => {
  const a = setup({
    send: function () {
      throw new Error('boom');
    },
  });
  await a.saver.save();
  assert.strictEqual(a.saver.isInflight(), false);
});

test('单飞闸在 send 拒绝时复位，下一次保存能重试并成功', async () => {
  let attempt = 0;
  const a = setup({
    send: function () {
      attempt++;
      if (attempt === 1) return Promise.reject(new Error('once'));
      return { written: true, bytes: 4, ms: 1 };
    },
  });
  assert.strictEqual(await a.saver.save(), null);
  const out = await a.saver.save();
  assert.strictEqual(out.written, true);
  assert.deepStrictEqual(a.cleans, [1]);
  assert.deepStrictEqual(a.sends, ['body', 'body']);
});

test('被单飞挡下的那次不产生 saving 状态，界面上只有一条 ignored', async () => {
  const gate = deferred();
  const a = setup({ send: function () { return gate.promise; } });
  const first = a.saver.save();
  await a.saver.save();
  assert.deepStrictEqual(a.statuses.filter(function (s) { return s[0] === 'save.saving'; }).length, 1);
  gate.resolve({ written: true, bytes: 4, ms: 1 });
  await first;
});

// ── 退编辑态：不发、不报 ────────────────────────────────────────────────
test('退编辑态后 isMounted=false 直接不发，也不报 saving', async () => {
  const a = setup({ isMounted: function () { return false; } });
  assert.strictEqual(await a.saver.save(), null);
  assert.deepStrictEqual(a.statuses, []);
  assert.deepStrictEqual(a.sends, []);
  assert.strictEqual(a.counter.getText, 0);
  assert.strictEqual(a.counter.mounted, 1);
});

test('isMounted=false 不占单飞闸：随后挂回仍能正常保存', async () => {
  let mounted = false;
  const a = setup({ isMounted: function () { return mounted; } });
  await a.saver.save();
  assert.strictEqual(a.saver.isInflight(), false);
  mounted = true;
  const out = await a.saver.save();
  assert.strictEqual(out.written, true);
  assert.deepStrictEqual(a.sends, ['body']);
});

test('没有 isMounted 依赖时视为一直挂载，照常保存', async () => {
  const a = setup();
  const out = await a.saver.save();
  assert.strictEqual(out.written, true);
});

// ── 源自 docs/bugs/0003（前端回报被静默拒收）────────────────────────────
// 每一次保存都必须留下一条可被界面接收的状态；失败那条必须带 isError=true。

test('0003 成功路径的状态序列完整：saving 先于 done，一条都不少', async () => {
  const a = setup();
  await a.saver.save();
  assert.deepStrictEqual(a.statuses.map(function (s) { return s[0]; }), ['save.saving', 'save.done {"bytes":4,"ms":"1.5"}']);
});

test('0003 失败路径的状态带 isError=true，不会被当普通提示吞掉', async () => {
  const a = setup({
    send: function () {
      throw new Error('io');
    },
  });
  await a.saver.save();
  assert.strictEqual(a.statuses.length, 2);
  assert.strictEqual(a.statuses[1][1], true);
});

test('0003 失败文案优先 e.wording，其次 e.message，都没有才用 save.failed', async () => {
  const byWording = setup({
    send: function () {
      const e = new Error('raw');
      e.wording = '磁盘已满';
      throw e;
    },
  });
  await byWording.saver.save();
  assert.match(byWording.statuses[1][0], /"msg":"磁盘已满"/);

  const byMessage = setup({
    send: function () {
      throw new Error('io broke');
    },
  });
  await byMessage.saver.save();
  assert.match(byMessage.statuses[1][0], /"msg":"io broke"/);
  assert.match(byMessage.statuses[1][0], /"path":""/);

  const bare = setup({
    send: function () {
      throw {};
    },
  });
  await bare.saver.save();
  assert.strictEqual(bare.statuses[1][0], 'save.failed-with {"msg":"save.failed","path":""}');
});

test('0003 错误对象带 path 时用 in-parens 拼进文案，不丢路径', async () => {
  const a = setup({
    send: function () {
      const e = new Error('permission');
      e.wording = '没有权限';
      e.path = '/a.md';
      throw e;
    },
  });
  await a.saver.save();
  assert.strictEqual(
    a.statuses[1][0],
    'save.failed-with {"msg":"没有权限","path":"common.in-parens {\\"path\\":\\"/a.md\\"}"}'
  );
});

test('0003 抛出的不是 Error（字符串 / null）也不会把保存卡死', async () => {
  const str = setup({
    send: function () {
      throw 'plain';
    },
  });
  assert.strictEqual(await str.saver.save(), null);
  assert.match(str.statuses[1][0], /"msg":"save.failed"/);
  const nul = setup({
    send: function () {
      throw null;
    },
  });
  assert.strictEqual(await nul.saver.save(), null);
  assert.strictEqual(nul.statuses[1][0], 'save.failed-with {"msg":"save.failed","path":""}');
});

// ── 源自 docs/bugs/0107（编辑面的静默失败）──────────────────────────────
// 失败要么不改行为、要么留痕；保存的失败必须伴随明确状态与未清脏。

test('0107 失败不报已保存、不清脏、不写 onDone，last 保持 null', async () => {
  const a = setup({
    send: function () {
      const e = new Error('disk full');
      e.wording = '磁盘已满';
      e.path = '/a.md';
      throw e;
    },
  });
  assert.strictEqual(await a.saver.save(), null);
  assert.deepStrictEqual(a.cleans, []);
  assert.deepStrictEqual(a.dones, []);
  assert.strictEqual(a.saver.last(), null);
  assert.strictEqual(a.saver.isInflight(), false);
});

test('0107 失败后修订号只取了一次（发出前的快照），重判不会执行', async () => {
  const a = setup({
    send: function () {
      throw new Error('x');
    },
  });
  await a.saver.save();
  assert.strictEqual(a.counter.rev, 1);
});

test('0107 失败不清上一次成功留下的 last（排障看到的是最后一次成功）', async () => {
  let fail = false;
  const a = setup({
    send: function () {
      if (fail) throw new Error('later');
      return { written: true, bytes: 4, ms: 1 };
    },
  });
  const ok = await a.saver.save();
  fail = true;
  assert.strictEqual(await a.saver.save(), null);
  assert.strictEqual(a.saver.last(), ok);
});

test('0107 退编辑态返回 null 是「没发出去」，不是失败：没有错误状态', async () => {
  const a = setup({ isMounted: function () { return false; } });
  await a.saver.save();
  assert.deepStrictEqual(a.statuses, []);
  assert.deepStrictEqual(a.cleans, []);
});

// ── 清脏前重判修订（§2.4-4）────────────────────────────────────────────
test('发送期间修订变了：报 done-but-dirty，⛔ 不清脏', async () => {
  let bump = false;
  const a = setup({
    rev: function () {
      return 1;
    },
    send: function () {
      bump = true;
      return { written: true, bytes: 4, ms: 1 };
    },
  });
  a.setRev(function () {
    return bump ? 2 : 1;
  });
  const out = await a.saver.save();
  assert.deepStrictEqual(a.statuses, [
    ['save.saving', false],
    ['save.done {"bytes":4,"ms":"1.0"}', false],
    ['save.done-but-dirty', false],
  ]);
  assert.deepStrictEqual(a.cleans, []);
  assert.strictEqual(a.dones[0], out);
});

test('发送期间修订没变才清脏（重判发生在发完之后）', async () => {
  const seen = [];
  const a = setup({
    rev: function () {
      seen.push('rev');
      return 9;
    },
  });
  await a.saver.save();
  assert.deepStrictEqual(a.cleans, [1]);
  assert.strictEqual(seen.length, 2);
});

test('done-but-dirty 之后仍可继续保存，第二次修订对上就清脏', async () => {
  let rev = 1;
  const a = setup({
    rev: function () { return rev; },
    send: function () {
      return { written: true, bytes: 4, ms: 1 };
    },
  });
  const first = a.saver.save();
  rev = 2;
  await first;
  assert.deepStrictEqual(a.cleans, []);
  await a.saver.save();
  assert.deepStrictEqual(a.cleans, [1]);
});

test('重判在 onStatus(done) 之后、onClean / onDone 之前', async () => {
  const a = setup();
  await a.saver.save();
  const statusOk = a.events.indexOf('status:ok');
  const clean = a.events.indexOf('clean');
  const done = a.events.indexOf('done');
  assert.ok(statusOk < clean);
  assert.ok(clean < done);
});

// ── 没有 i18n 时的回落 ──────────────────────────────────────────────────
test('没有 i18n 时文案回落成 key 本身，屏幕上是看得见的坏而不是空白', async () => {
  const a = setup({
    send: function () {
      return { written: false, bytes: 0, ms: 0 };
    },
  }, S_RAW);
  await a.saver.save();
  assert.deepStrictEqual(a.statuses, [
    ['save.saving', false],
    ['save.no-change', false],
  ]);
});

test('没有 i18n 时失败文案也回落成 key（含带参那条）', async () => {
  const a = setup({
    send: function () {
      throw new Error('x');
    },
  }, S_RAW);
  await a.saver.save();
  assert.deepStrictEqual(a.statuses, [
    ['save.saving', false],
    ['save.failed-with', true],
  ]);
});

test('没有 i18n 时 done-but-dirty 也回落成 key', async () => {
  let bump = false;
  const a = setup({
    rev: function () { return bump ? 2 : 1; },
    send: function () {
      bump = true;
      return { written: true, bytes: 1, ms: 1 };
    },
  }, S_RAW);
  await a.saver.save();
  assert.deepStrictEqual(a.statuses, [
    ['save.saving', false],
    ['save.done', false],
    ['save.done-but-dirty', false],
  ]);
});

// ── 契约外输入（2026-11-09 改判：`bugs/0296` 的「隔离 + 兜底」已落地）─────────────
test('0296 send 回包缺 ms 时按 0 兜底：保存照常完成、清脏并交回 last', async () => {
  // 旧实现 `out ? out.ms.toFixed(1) : '0'` 只挡了 `out == null`；后端若回 `{written,bytes}`
  // 而无 `ms`，会在成功路径抛 TypeError ⇒ 磁盘已写、`onClean` / `onDone` 都不执行。
  // 现口径：非有限数按 `0` 显示，清脏与 `onDone` 不被文案拼装拖累（`bugs/0296` §5）。
  const a = setup({
    send: function () {
      return { written: true, bytes: 4 };
    },
  });
  const out = await a.saver.save();
  assert.deepStrictEqual(a.statuses, [
    ['save.saving', false],
    ['save.done {"bytes":4,"ms":"0"}', false],
  ]);
  assert.deepStrictEqual(a.cleans, [1]);
  assert.deepStrictEqual(a.dones, [out]);
  assert.strictEqual(a.saver.isInflight(), false);
  assert.deepStrictEqual(a.saver.last(), { written: true, bytes: 4 });
});

test('0296 onStatus(saving) 抛错被隔离：单飞闸照常放开，下一次保存正常发出', async () => {
  // 旧实现把 `inflight = true` 与 `onStatus(saving)` 留在 try 之外 ⇒ 回调抛错时 finally
  // 不执行，保存器永久「在途」，用户再按 ⌘S 只看到 ignored。现口径：所有界面回调经
  // `safeCall` 隔离（异常只进 console.error），保存流程照旧走完（`bugs/0296` §5）。
  const win = { rmd: { i18n: { t: function (k) { return k; } } } };
  const src = fs.readFileSync(path.join(ROOT, 'src/editor/save.js'), 'utf8');
  new Function('window', src)(win);
  let throwOnce = true;
  const statuses = [];
  let sends = 0;
  const saver = win.rmd.editorSave.createSaver({
    getText: function () { return 'x'; },
    rev: function () { return 0; },
    send: function () {
      sends++;
      return Promise.resolve({ written: true, bytes: 1, ms: 1 });
    },
    onStatus: function (s, isError) {
      statuses.push([s, isError]);
      if (throwOnce) {
        throwOnce = false;
        throw new Error('ui callback bug');
      }
    },
    onClean: function () {},
  });
  const out = await saver.save();
  assert.strictEqual(out.written, true);
  assert.strictEqual(sends, 1);
  assert.strictEqual(saver.isInflight(), false);
  assert.deepStrictEqual(statuses, [['save.saving', false], ['save.done', false]]);
  // 负对照：第二次保存必须真的发出去（⛔ 不是 `save.ignored`）
  await saver.save();
  assert.strictEqual(sends, 2);
  assert.deepStrictEqual(statuses[2], ['save.saving', false]);
});
