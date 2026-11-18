// 保存唯一入口：单飞、发出时的文本 / 修订快照、失败不报已保存、清脏前重判修订。
// 守的是 `INV-EDIT-10` 与 `design/0012` §2.4-4「rename 期间还能输入」那条静默丢失。
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
  const counter = { getText: 0, rev: 0, mounted: 0 };
  let text = o.text === undefined ? 'body' : o.text;
  let rev = o.rev === undefined ? 0 : o.rev;
  const saver = (api || S).createSaver({
    getText: function () {
      counter.getText++;
      return typeof text === 'function' ? text() : text;
    },
    rev: function () {
      counter.rev++;
      return typeof rev === 'function' ? rev() : rev;
    },
    send: async function (txt) {
      sends.push(txt);
      if (o.send) return o.send(txt);
      return { written: true, bytes: txt.length, ms: 1.5 };
    },
    onStatus: function (s, isError) {
      statuses.push([s, isError]);
    },
    onClean: function () {
      cleans.push(1);
    },
    onDone: o.noDone
      ? undefined
      : function (out) {
        dones.push(out);
      },
    isMounted: o.isMounted
      ? function () {
        counter.mounted++;
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
    counter: counter,
    setText: function (v) { text = v; },
    setRev: function (v) { rev = v; },
  };
}

test('成功保存：saving → done（带字节与一位小数毫秒），清脏一次并交回 last', () => {
  return (async function () {
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
  })();
});

test('written=false 用 no-change 文案，⛔ 不把它说成已保存', () => {
  return (async function () {
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
  })();
});

test('发出的文本与修订都在发起那一刻取，send 拿到的是同一份', () => {
  return (async function () {
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
  })();
});

test('单飞：在途时第二次 save 返回 null、只报 ignored，不发第二个请求', () => {
  return (async function () {
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

test('退编辑态后 isMounted=false 直接不发，也不报 saving', () => {
  return (async function () {
    const a = setup({ isMounted: function () { return false; } });
    assert.strictEqual(await a.saver.save(), null);
    assert.deepStrictEqual(a.statuses, []);
    assert.deepStrictEqual(a.sends, []);
    assert.strictEqual(a.counter.getText, 0);
    assert.strictEqual(a.counter.mounted, 1);
  })();
});

test('失败时不报已保存、不清脏、不写 onDone，last 保持 null', () => {
  return (async function () {
    const a = setup({
      send: function () {
        const err = new Error('disk full');
        err.wording = '磁盘已满';
        err.path = '/a.md';
        throw err;
      },
    });
    assert.strictEqual(await a.saver.save(), null);
    assert.deepStrictEqual(a.statuses, [
      ['save.saving', false],
      ['save.failed-with {"msg":"磁盘已满","path":"common.in-parens {\\"path\\":\\"/a.md\\"}"}', true],
    ]);
    assert.deepStrictEqual(a.cleans, []);
    assert.deepStrictEqual(a.dones, []);
    assert.strictEqual(a.saver.last(), null);
    assert.strictEqual(a.saver.isInflight(), false);
  })();
});

test('失败文案优先 e.wording，其次 e.message，都没有才用 save.failed', () => {
  return (async function () {
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
    assert.strictEqual(bare.statuses[1][1], true);
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

test('发送期间修订变了：报 done-but-dirty，⛔ 不清脏', () => {
  return (async function () {
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
  })();
});

test('发送期间修订没变才清脏（重判发生在发完之后）', () => {
  return (async function () {
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
  })();
});

test('发出的修订号只需在取文本之后取一次；文本本身不参与重判', () => {
  return (async function () {
    let text = 'before';
    const a = setup({
      rev: function () {
        return 0;
      },
      send: function () {
        text = 'after';
        return { written: true, bytes: 6, ms: 1 };
      },
    });
    a.setText(function () { return text; });
    await a.saver.save();
    // 产品只重判修订号；这里文本变了而修订没变 ⇒ 按当前行为仍清脏。
    assert.deepStrictEqual(a.cleans, [1]);
    assert.deepStrictEqual(a.sends, ['before']);
  })();
});

test('onDone 可以省略，保存照常成功', () => {
  return (async function () {
    const a = setup({ noDone: true });
    const out = await a.saver.save();
    assert.strictEqual(out.written, true);
    assert.deepStrictEqual(a.cleans, [1]);
  })();
});

test('返回值就是 send 的结果本体，last 也是同一个引用', () => {
  return (async function () {
    const payload = { written: true, bytes: 4, ms: 0 };
    const a = setup({
      send: function () {
        return payload;
      },
    });
    const out = await a.saver.save();
    assert.strictEqual(out, payload);
    assert.strictEqual(a.saver.last(), payload);
  })();
});

test('没有 i18n 时文案回落成 key 本身，屏幕上是看得见的坏而不是空白', () => {
  return (async function () {
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
  })();
});

test('没有 i18n 时失败文案也回落成 key（含带参那条）', () => {
  return (async function () {
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
  })();
});

test('成功文案的毫秒保留一位小数，字节用 0 兜底', () => {
  return (async function () {
    const a = setup({
      send: function () {
        return { written: true, bytes: 0, ms: 12.345 };
      },
    });
    await a.saver.save();
    assert.strictEqual(a.statuses[1][0], 'save.done {"bytes":0,"ms":"12.3"}');
  })();
});

test('单飞闸在 send 抛错时也由 finally 复位（finally 在 catch 之后）', () => {
  return (async function () {
    const a = setup({
      send: function () {
        throw new Error('boom');
      },
    });
    await a.saver.save();
    assert.strictEqual(a.saver.isInflight(), false);
  })();
});
