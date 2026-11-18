// 保存唯一入口：单飞、发出时的文本 / 修订快照、失败不报已保存、清脏前重判修订。
// 本文件从 docs/bugs 的历史缺陷出发，守住「静默失败 / 异步旧包改写状态 / 把未保存说成已保存」。
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
  const log = [];
  const counter = { getText: 0, rev: 0, mounted: 0 };
  let text = o.text === undefined ? 'body' : o.text;
  let rev = o.rev === undefined ? 0 : o.rev;
  const saver = (api || S).createSaver({
    getText: function () {
      counter.getText++;
      log.push('text');
      return typeof text === 'function' ? text() : text;
    },
    rev: function () {
      counter.rev++;
      log.push('rev');
      return typeof rev === 'function' ? rev() : rev;
    },
    send: async function (txt) {
      log.push('send');
      sends.push(txt);
      if (o.send) return o.send(txt);
      return { written: true, bytes: txt.length, ms: 1.5 };
    },
    onStatus: function (s, isError) {
      log.push('status');
      statuses.push([s, isError]);
    },
    onClean: function () {
      log.push('clean');
      cleans.push(1);
    },
    onDone: o.noDone ? undefined : function (out) {
      log.push('done');
      dones.push(out);
    },
    isMounted: o.isMounted ? function () {
      counter.mounted++;
      return o.isMounted();
    } : undefined,
  });
  return {
    saver: saver,
    statuses: statuses,
    cleans: cleans,
    dones: dones,
    sends: sends,
    log: log,
    counter: counter,
    setText: function (v) { text = v; },
    setRev: function (v) { rev = v; },
  };
}

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0004（编辑态改了字，预览不会自动跟上，界面上也没有任何提示）
// ——————————————————————————————————————————————————————————————

test('成功保存：saving → done，清脏一次、onDone 一次、last 就是回包', () => {
  return (async function () {
    const a = setup();
    const out = await a.saver.save();
    assert.deepStrictEqual(a.statuses, [
      ['save.saving', false],
      ['save.done {"bytes":4,"ms":"1.5"}', false],
    ]);
    assert.deepStrictEqual(a.cleans, [1]);
    assert.deepStrictEqual(a.dones, [out]);
    assert.strictEqual(a.saver.last(), out);
    assert.deepStrictEqual(a.sends, ['body']);
  })();
});

test('发请求之前一定先写 saving：用户看得到「正在保存」', () => {
  return (async function () {
    const a = setup();
    await a.saver.save();
    assert.deepStrictEqual(a.statuses[0], ['save.saving', false]);
    assert.deepStrictEqual(a.log.slice(0, 3), ['text', 'rev', 'status']);
  })();
});

test('written=false（no-op 短路）用 no-change 文案，⛔ 不说成已保存', () => {
  return (async function () {
    const a = setup({ send: function () { return { written: false, bytes: 0, ms: 0.2 }; } });
    const out = await a.saver.save();
    assert.strictEqual(out.written, false);
    assert.deepStrictEqual(a.statuses, [
      ['save.saving', false],
      ['save.no-change', false],
    ]);
    assert.deepStrictEqual(a.cleans, [1]);
  })();
});

test('onDone 可以省略，成功路径照常清脏', () => {
  return (async function () {
    const a = setup({ noDone: true });
    const out = await a.saver.save();
    assert.strictEqual(out.written, true);
    assert.deepStrictEqual(a.cleans, [1]);
  })();
});

test('没有 i18n 时文案回落成 key 本身：屏幕上是看得见的坏，⛔ 不是空白', () => {
  return (async function () {
    const a = setup({
      send: function () { return { written: false, bytes: 0, ms: 0 }; },
    }, S_RAW);
    await a.saver.save();
    assert.deepStrictEqual(a.statuses, [
      ['save.saving', false],
      ['save.no-change', false],
    ]);
  })();
});

test('成功文案的毫秒保留一位小数，字节用 0 兜底', () => {
  return (async function () {
    const a = setup({
      send: function () { return { written: true, bytes: 0, ms: 12.345 }; },
    });
    await a.saver.save();
    assert.strictEqual(a.statuses[1][0], 'save.done {"bytes":0,"ms":"12.3"}');
  })();
});

test('返回的就是 send 的结果本体，last 也是同一个引用', () => {
  return (async function () {
    const payload = { written: true, bytes: 4, ms: 0 };
    const a = setup({ send: function () { return payload; } });
    const out = await a.saver.save();
    assert.strictEqual(out, payload);
    assert.strictEqual(a.saver.last(), payload);
  })();
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0107（格子里的按键偶尔「什么都没发生」：编辑面四处静默失败）
// ——————————————————————————————————————————————————————————————

test('失败必须可见：saving → failed-with，isError=true，⛔ 不说已保存', () => {
  return (async function () {
    const a = setup({ send: function () { throw new Error('disk full'); } });
    assert.strictEqual(await a.saver.save(), null);
    assert.deepStrictEqual(a.statuses, [
      ['save.saving', false],
      ['save.failed-with {"msg":"disk full","path":""}', true],
    ]);
    assert.strictEqual(a.statuses[1][1], true);
  })();
});

test('失败不清脏、不调 onDone、last 保持 null（没有成功过）', () => {
  return (async function () {
    const a = setup({ send: function () { throw new Error('x'); } });
    await a.saver.save();
    assert.deepStrictEqual(a.cleans, []);
    assert.deepStrictEqual(a.dones, []);
    assert.strictEqual(a.saver.last(), null);
  })();
});

test('失败文案优先 e.wording，其次 e.message，都没有才用 save.failed', () => {
  return (async function () {
    const byWording = setup({
      send: function () {
        const e = new Error('raw');
        e.wording = '磁盘已满';
        throw e;
      },
    });
    await byWording.saver.save();
    assert.match(byWording.statuses[1][0], /"msg":"磁盘已满"/);

    const byMessage = setup({ send: function () { throw new Error('io broke'); } });
    await byMessage.saver.save();
    assert.match(byMessage.statuses[1][0], /"msg":"io broke"/);

    const bare = setup({ send: function () { throw {}; } });
    await bare.saver.save();
    assert.strictEqual(bare.statuses[1][0], 'save.failed-with {"msg":"save.failed","path":""}');
  })();
});

test('错误带 path 时文案里带上「(路径)」，不带时不出现空括号', () => {
  return (async function () {
    const withPath = setup({
      send: function () {
        const e = new Error('no');
        e.path = '/a.md';
        throw e;
      },
    });
    await withPath.saver.save();
    assert.match(withPath.statuses[1][0], /common\.in-parens/);
    assert.match(withPath.statuses[1][0], /\/a\.md/);

    const noPath = setup({ send: function () { throw new Error('no'); } });
    await noPath.saver.save();
    assert.match(noPath.statuses[1][0], /"path":""/);
  })();
});

test('抛出的不是 Error 而是字符串时，也回落成 save.failed 而不是拼出 undefined', () => {
  return (async function () {
    const a = setup({ send: function () { throw 'plain-string'; } });
    await a.saver.save();
    assert.strictEqual(a.statuses[1][0], 'save.failed-with {"msg":"save.failed","path":""}');
  })();
});

test('失败后 inflight 复位，下一次保存能重试并成功', () => {
  return (async function () {
    let attempt = 0;
    const a = setup({
      send: function () {
        attempt++;
        if (attempt === 1) throw new Error('once');
        return { written: true, bytes: 4, ms: 1 };
      },
    });
    assert.strictEqual(await a.saver.save(), null);
    const out = await a.saver.save();
    assert.strictEqual(out.written, true);
    assert.deepStrictEqual(a.cleans, [1]);
    assert.deepStrictEqual(a.sends, ['body', 'body']);
  })();
});

test('失败不清上一次成功留下的 last（排障看到的是最后一次成功）', () => {
  return (async function () {
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
  })();
});

test('失败时不重判修订号：rev 只取了发起前那一次', () => {
  return (async function () {
    const a = setup({ send: function () { throw new Error('x'); } });
    await a.saver.save();
    assert.strictEqual(a.counter.rev, 1);
  })();
});

test('getText 抛错时 inflight 不会被卡住，也不发请求', () => {
  return (async function () {
    const a = setup({ text: function () { throw new Error('no-text'); } });
    await assert.rejects(a.saver.save(), /no-text/);
    assert.strictEqual(a.saver.isInflight(), false);
    assert.deepStrictEqual(a.sends, []);
  })();
});

test('rev 抛错时 inflight 不会被卡住，也不发请求', () => {
  return (async function () {
    const a = setup({ rev: function () { throw new Error('no-rev'); } });
    await assert.rejects(a.saver.save(), /no-rev/);
    assert.strictEqual(a.saver.isInflight(), false);
    assert.deepStrictEqual(a.sends, []);
    assert.deepStrictEqual(a.statuses, []);
  })();
});

test('isMounted 抛错时同样不会把 inflight 卡死', () => {
  return (async function () {
    const a = setup({ isMounted: function () { throw new Error('no-mount'); } });
    await assert.rejects(a.saver.save(), /no-mount/);
    assert.strictEqual(a.saver.isInflight(), false);
    assert.deepStrictEqual(a.sends, []);
  })();
});

test('saving 状态回调抛错不卡死单飞闸（bugs/0296）', () => {
  return (async function () {
    const origErr = console.error;
    const logged = [];
    console.error = function () { logged.push(Array.prototype.slice.call(arguments)); };
    try {
      let calls = 0;
      const sends = [];
      const saver = S.createSaver({
        getText: function () { return 'body'; },
        rev: function () { return 0; },
        send: async function (txt) { sends.push(txt); return { written: true, bytes: 4, ms: 1 }; },
        onStatus: function () {
          calls++;
          if (calls === 1) throw new Error('status-down');
        },
        onClean: function () {},
      });
      // ⛔ 不再 reject：回包是契约外输入，界面回调坏了不能让保存状态机跟着坏。
      const out = await saver.save();
      assert.strictEqual(out.written, true);
      assert.strictEqual(saver.isInflight(), false);
      // 抛错仍然要看得见（⛔ 不吞成无事发生）。
      assert.strictEqual(logged.length, 1);
      // 单飞闸真的放开了：第二次仍然发得出去。
      await saver.save();
      assert.deepStrictEqual(sends, ['body', 'body']);
    } finally {
      console.error = origErr;
    }
  })();
});

test('回包缺 ms 时不再抛 TypeError：脏标记照清、onDone 照调（bugs/0296）', () => {
  return (async function () {
    const a = setup({
      send: function () { return { written: true, bytes: 3 }; },
    });
    const out = await a.saver.save();
    assert.strictEqual(out.bytes, 3);
    assert.strictEqual(a.saver.isInflight(), false);
    assert.deepStrictEqual(a.cleans, [1]);
    assert.deepStrictEqual(a.dones, [out]);
    const last = a.statuses[a.statuses.length - 1][0];
    assert.match(last, /"ms":"0"/);
    assert.match(last, /"bytes":3/);
  })();
});

// ——————————————————————————————————————————————————————————————
// 源自 docs/bugs/0064（换文档后旧预览回包把状态恢复成编辑态）
// ——————————————————————————————————————————————————————————————

test('退编辑态（isMounted=false）时直接不发，连文本都不取', () => {
  return (async function () {
    const a = setup({ isMounted: function () { return false; } });
    assert.strictEqual(await a.saver.save(), null);
    assert.deepStrictEqual(a.statuses, []);
    assert.deepStrictEqual(a.sends, []);
    assert.strictEqual(a.counter.getText, 0);
    assert.strictEqual(a.counter.mounted, 1);
  })();
});

test('单飞优先于 isMounted：在途时即使已退编辑态，第二次也报 ignored', () => {
  return (async function () {
    const gate = deferred();
    let mounted = true;
    const a = setup({
      isMounted: function () { return mounted; },
      send: function () { return gate.promise; },
    });
    const first = a.saver.save();
    mounted = false;
    assert.strictEqual(await a.saver.save(), null);
    assert.deepStrictEqual(a.statuses[0], ['save.saving', false]);
    assert.deepStrictEqual(a.statuses[1], ['save.ignored', false]);
    gate.resolve({ written: true, bytes: 4, ms: 1 });
    await first;
  })();
});

test('⚠️ 疑似缺陷：保存期间退编辑态（rev 被重置）会误报 done-but-dirty', () => {
  return (async function () {
    let rev = 1;
    let mounted = true;
    const a = setup({
      rev: function () { return rev; },
      isMounted: function () { return mounted; },
      send: function () {
        // 模拟 unmount()：视图销毁后 revision() 归零。
        mounted = false;
        rev = 0;
        return { written: true, bytes: 4, ms: 1 };
      },
    });
    const out = await a.saver.save();
    assert.strictEqual(out.written, true);
    assert.deepStrictEqual(a.statuses, [
      ['save.saving', false],
      ['save.done {"bytes":4,"ms":"1.0"}', false],
      ['save.done-but-dirty', false],
    ]);
    assert.deepStrictEqual(a.cleans, []);
  })();
});

test('在途时第二次保存返回 null、只报 ignored，且不重新取文本 / 修订', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ send: function () { return gate.promise; } });
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
  })();
});

test('单飞闸在成功后复位，下一次保存照常发出', () => {
  return (async function () {
    const a = setup();
    await a.saver.save();
    await a.saver.save();
    assert.deepStrictEqual(a.sends, ['body', 'body']);
    assert.strictEqual(a.saver.isInflight(), false);
  })();
});

test('单飞闸在 send 抛错时也由 finally 复位', () => {
  return (async function () {
    const a = setup({ send: function () { throw new Error('boom'); } });
    await a.saver.save();
    assert.strictEqual(a.saver.isInflight(), false);
  })();
});

test('三次并发保存只有第一次真的发出，后两次都拿 ignored', () => {
  return (async function () {
    const gate = deferred();
    const a = setup({ send: function () { return gate.promise; } });
    const p1 = a.saver.save();
    const p2 = a.saver.save();
    const p3 = a.saver.save();
    assert.strictEqual(await p2, null);
    assert.strictEqual(await p3, null);
    gate.resolve({ written: true, bytes: 4, ms: 1 });
    await p1;
    assert.strictEqual(a.sends.length, 1);
    assert.deepStrictEqual(a.statuses.slice(0, 3).map(function (s) { return s[0]; }), [
      'save.saving', 'save.ignored', 'save.ignored',
    ]);
  })();
});

// ——————————————————————————————————————————————————————————————
// 修订号复核：清脏之前必须重判「缓冲还是不是发出去的那份」
// ——————————————————————————————————————————————————————————————

test('取文本与取修订之间没有 await：调用顺序是 text → rev', () => {
  const a = setup();
  a.saver.save();
  assert.deepStrictEqual(a.log.slice(0, 2), ['text', 'rev']);
});

test('成功路径 rev 恰取两次：发起前快照 ＋ 落地后复核', () => {
  return (async function () {
    const a = setup();
    await a.saver.save();
    assert.strictEqual(a.counter.rev, 2);
  })();
});

test('发送期间修订没变 ⇒ 清脏一次', () => {
  return (async function () {
    const a = setup({ rev: function () { return 9; } });
    await a.saver.save();
    assert.deepStrictEqual(a.cleans, [1]);
  })();
});

test('发送期间修订变了 ⇒ done-but-dirty，⛔ 不清脏', () => {
  return (async function () {
    let rev = 1;
    const a = setup({
      rev: function () { return rev; },
      send: function () {
        rev = 2;
        return { written: true, bytes: 4, ms: 1 };
      },
    });
    const out = await a.saver.save();
    assert.deepStrictEqual(a.statuses, [
      ['save.saving', false],
      ['save.done {"bytes":4,"ms":"1.0"}', false],
      ['save.done-but-dirty', false],
    ]);
    assert.deepStrictEqual(a.cleans, []);
    assert.strictEqual(a.dones[0], out);
  })();
});

test('修订号变了又变回来 ⇒ 按相等清脏（只比数字，不追中间历史）', () => {
  return (async function () {
    let rev = 1;
    const a = setup({
      rev: function () { return rev; },
      send: function () {
        rev = 2;
        rev = 1;
        return { written: true, bytes: 4, ms: 1 };
      },
    });
    await a.saver.save();
    assert.deepStrictEqual(a.cleans, [1]);
    assert.strictEqual(a.statuses.some(function (s) { return s[0] === 'save.done-but-dirty'; }), false);
  })();
});

test('⚠️ 疑似缺陷：只重判修订号，不重判文本；文本变了而修订没变仍清脏', () => {
  return (async function () {
    let text = 'before';
    const a = setup({
      text: function () { return text; },
      rev: function () { return 0; },
      send: function () {
        text = 'after';
        return { written: true, bytes: 6, ms: 1 };
      },
    });
    await a.saver.save();
    assert.deepStrictEqual(a.sends, ['before']);
    assert.deepStrictEqual(a.cleans, [1]);
  })();
});

test('复核发生在成功文案之后、onClean 之前', () => {
  return (async function () {
    const a = setup();
    await a.saver.save();
    assert.deepStrictEqual(a.log, ['text', 'rev', 'status', 'send', 'status', 'rev', 'clean', 'done']);
  })();
});

test('done-but-dirty 的 isError 是 false：那不是错误，是「你刚又改了」', () => {
  return (async function () {
    let rev = 1;
    const a = setup({
      rev: function () { return rev; },
      send: function () { rev = 2; return { written: true, bytes: 4, ms: 1 }; },
    });
    await a.saver.save();
    assert.deepStrictEqual(a.statuses[a.statuses.length - 1], ['save.done-but-dirty', false]);
  })();
});

test('done-but-dirty 仍然调 onDone（保存本身成功，只是缓冲又脏了）', () => {
  return (async function () {
    let rev = 1;
    const a = setup({
      rev: function () { return rev; },
      send: function () { rev = 2; return { written: true, bytes: 4, ms: 1 }; },
    });
    const out = await a.saver.save();
    assert.deepStrictEqual(a.dones, [out]);
  })();
});

test('no-change 也走同一道复核：修订变了照样 done-but-dirty 且不清脏', () => {
  return (async function () {
    let rev = 1;
    const a = setup({
      rev: function () { return rev; },
      send: function () { rev = 2; return { written: false, bytes: 0, ms: 0 }; },
    });
    await a.saver.save();
    assert.deepStrictEqual(a.statuses.map(function (s) { return s[0]; }), [
      'save.saving', 'save.no-change', 'save.done-but-dirty',
    ]);
    assert.deepStrictEqual(a.cleans, []);
  })();
});

// ——————————————————————————————————————————————————————————————
// 回包形状的边界（契约外输入）
// ——————————————————————————————————————————————————————————————

test('send 返回 null 时按 0 字节 / 0ms 报 done，并按修订复核清脏', () => {
  return (async function () {
    const a = setup({ send: function () { return null; } });
    const out = await a.saver.save();
    assert.strictEqual(out, null);
    assert.deepStrictEqual(a.statuses, [
      ['save.saving', false],
      ['save.done {"bytes":0,"ms":"0"}', false],
    ]);
    assert.deepStrictEqual(a.cleans, [1]);
    assert.strictEqual(a.saver.last(), null);
  })();
});

test('send 返回 undefined 时同样不崩，按 0 字节 / 0ms 报 done', () => {
  return (async function () {
    const a = setup({ send: function () { return undefined; } });
    await a.saver.save();
    assert.strictEqual(a.statuses[1][0], 'save.done {"bytes":0,"ms":"0"}');
  })();
});

test('written 只与 false 严格比较：written=0 / undefined 都当普通成功', () => {
  return (async function () {
    const zero = setup({ send: function () { return { written: 0, bytes: 1, ms: 1 }; } });
    await zero.saver.save();
    assert.match(zero.statuses[1][0], /^save\.done/);

    const undef = setup({ send: function () { return { bytes: 1, ms: 1 }; } });
    await undef.saver.save();
    assert.match(undef.statuses[1][0], /^save\.done/);
  })();
});

test('send 返回负 ms 时 toFixed 照常，不把负值当特殊状态', () => {
  return (async function () {
    const a = setup({ send: function () { return { written: true, bytes: 1, ms: -3.14 }; } });
    await a.saver.save();
    assert.strictEqual(a.statuses[1][0], 'save.done {"bytes":1,"ms":"-3.1"}');
  })();
});

test('save 的返回值在失败 / 忽略 / 退编辑态三种情况下都是 null', () => {
  return (async function () {
    const fail = setup({ send: function () { throw new Error('x'); } });
    assert.strictEqual(await fail.saver.save(), null);

    const gate = deferred();
    const busy = setup({ send: function () { return gate.promise; } });
    const first = busy.saver.save();
    assert.strictEqual(await busy.saver.save(), null);
    gate.resolve({ written: true, bytes: 4, ms: 1 });
    await first;

    const off = setup({ isMounted: function () { return false; } });
    assert.strictEqual(await off.saver.save(), null);
  })();
});

test('opts.now 没有被保存器使用：计时由调用方 / 回包负责', () => {
  return (async function () {
    let nowCalls = 0;
    const saver = S.createSaver({
      getText: function () { return 'x'; },
      rev: function () { return 0; },
      send: async function () { return { written: true, bytes: 1, ms: 1 }; },
      onStatus: function () {},
      onClean: function () {},
      now: function () { nowCalls++; return 0; },
    });
    await saver.save();
    assert.strictEqual(nowCalls, 0);
  })();
});
