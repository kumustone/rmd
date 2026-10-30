// `design/0041` §7 的 JS 判据之二：**分片生命周期（R3）与"可见才画"（§2.3）**。
//
// ⭐ 这一格钉住的是评审给的那个反例：**同根刷新 / 切形态 / 卸载都不改授权代次**，
//    只看 `gen` 的话旧分片会接着往容器里追加。当时的实际表现是**残留 500 行旧内容**——
//    页面上看起来"就是有这么多文档"，是**静默的错误内容**（`INV-DOCS-09`）。
// ⇒ 断言一律看**最终节点路径集合与数量**，⛔ 不是"代次变化会停"这种间接判据。
//
// ⚠️ 这里用的是**假 DOM**（`document.createElement` 的最小实现）与**假后端**（`invoke`）：
//    真 DOM 那一半在 `make probe-doclist`（离屏 WKWebView，真 `DocList.js`）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ⚠️ 先立 `window` 再 `require`：`session.js` 加载期只做 require，但它链上那份
//    `tauri.js` 每次现取 `window.__TAURI__`（与 `session.test.js` 同款前置）。
global.window = {
  __TAURI__: {
    core: { invoke: function () { throw new Error('未安装 fake invoke'); } },
  },
};

/** 假 DOM 节点：`appendChild` / `remove` 都如实记账，`textContent = ''` 会清空子节点。 */
function makeEl(tag) {
  let text = '';
  const n = {
    tagName: tag,
    className: '',
    title: '',
    tabIndex: 0,
    dataset: {},
    attrs: {},
    children: [],
    parentNode: null,
    /** 记下监听器，让用例能"点一行"（⛔ 不模拟完整的事件系统）。 */
    handlers: {},
    appendChild: function (c) { c.parentNode = n; n.children.push(c); return c; },
    setAttribute: function (k, v) { n.attrs[k] = v; },
    addEventListener: function (type, fn) { n.handlers[type] = fn; },
    remove: function () {
      const p = n.parentNode;
      if (!p) return;
      const i = p.children.indexOf(n);
      if (i >= 0) p.children.splice(i, 1);
      n.parentNode = null;
    },
  };
  Object.defineProperty(n, 'textContent', {
    get: function () { return text; },
    set: function (v) {
      text = String(v);
      // ⚠️ 与浏览器的 `textContent = ''` 一致：**子节点一起没了**
      //    （`DocList.clearHost` 靠的就是这一条）。
      if (text === '') {
        for (let i = 0; i < n.children.length; i++) n.children[i].parentNode = null;
        n.children.length = 0;
      }
    },
  });
  return n;
}

global.document = { createElement: makeEl };

const S = require('../../src/services/session.js');
const DocListUI = require('../../src/components/DocList.js');

/** 把一棵假 DOM 走一遍，数出满足判据的节点。 */
function walk(node, out) {
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) {
    out.push(kids[i]);
    walk(kids[i], out);
  }
  return out;
}
function rows(host) {
  return walk(host, []).filter(function (n) { return n.className === 'doclist-row'; });
}
function notes(host) {
  return walk(host, []).filter(function (n) { return n.className.indexOf('doclist-note') === 0; });
}
function rowPaths(host) {
  return rows(host).map(function (n) { return n.dataset.path; });
}

function snapshot(over) {
  return Object.assign({
    generation: 1,
    mode: 'directory',
    roots: ['/rootA'],
    files: [],
    pending_directory: null,
    sidebar_width: 280,
    last_directory: null,
    reading_progress: {},
    dir_session: null,
    doc_seq: 10,
    sidebar_file_view: 'tree',
    hide_empty_dirs: true,
  }, over || {});
}

/** 造 `n` 条条目（名字与路径都唯一，便于按集合比较）。 */
function entries(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      root: '/rootA',
      real_path: '/rootA/' + (prefix || 'd') + '/f' + i + '.md',
      rel: (prefix || 'd') + '/f' + i + '.md',
      name: 'f' + i + '.md',
    });
  }
  return out;
}

/**
 * 让已排队的 `setTimeout(0)` 分片全部跑完。
 * ⚠️ 每一片都要**一轮宏任务**（`chunked.js` 的默认调度在 node 下退回 `setTimeout`），
 *    所以这里轮数要够 `MAX_RENDER / CHUNK_STEP` 那十片（⛔ 不睡真时间）。
 */
async function drain() {
  for (let i = 0; i < 40; i++) {
    await new Promise(function (r) { setTimeout(r, 0); });
  }
}

/**
 * 假后端：`list_documents` 回什么由 `fake.listEntries` 决定；
 * `genDelta` / `reqDelta` 让用例故意回一份**不该被接受**的包；
 * `gate`（可手控 Promise）让某一次请求**挂着不回来**——用来把"旧分片还在调度"
 * 与"新回包已到"这两个时刻**错开**（⛔ 不睡真时间）。
 */
function installFake() {
  const fake = {
    snap: snapshot(),
    listEntries: [],
    genDelta: 0,
    reqDelta: 0,
    gate: null,
    calls: 0,
    install: function () {
      global.window.__TAURI__.core.invoke = function (cmd, args) {
        if (cmd === 'get_session') return Promise.resolve(JSON.parse(JSON.stringify(fake.snap)));
        if (cmd === 'list_documents') {
          fake.calls += 1;
          const payload = {
            gen: args.generation + fake.genDelta,
            req: args.req + fake.reqDelta,
            index_rev: fake.calls,       // 每次请求都更新 ⇒ 不倒退
            age_ms: 1,
            complete: true,
            incomplete: [],
            incomplete_truncated: false,
            roots: ['/rootA'],
            entries: fake.listEntries.slice(),
            keep_dirs: ['/rootA/d'],
            total: fake.listEntries.length,
            truncated: false,
            max_docs: 10000,
            stats: {},
          };
          if (fake.gate) {
            const g = fake.gate;
            fake.gate = null;
            return g.promise.then(function () { return payload; });
          }
          return Promise.resolve(payload);
        }
        throw new Error('未预料的命令：' + cmd);
      };
    },
    reset: async function (snap) {
      fake.snap = snap || snapshot();
      await S.refresh();
    },
  };
  return fake;
}

/** 可手控的 Promise（与 `session.test.js` / `dirsession.test.js` 同款）。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
  return { promise: promise, resolve: resolve, reject: reject };
}

function makeHost() { return makeEl('div'); }

test('⭐ 评审反例：旧任务排了 1 000 行、首片 500 行之后同根刷新 ⇒ 最终只剩新那份的内容', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset();

  const host = makeHost();
  const dl = DocListUI.createDocList({ host: host, onOpenFile: function () {} });
  dl.setActive(true);

  fake.listEntries = entries(1000, 'old');
  await dl.refresh();
  // 首片（`CHUNK_FIRST` = 500）是**同步**做的，剩下的排进 `setTimeout`
  assert.strictEqual(rows(host).length, V_FIRST(), '首片没画出来 —— 前置不成立');
  // ⚠️ 抓住**旧那一份**的行容器：旧分片到底停没停，只能在这里看出来。
  //    新的一份会把 `#pane-doclist` 清空并换上自己的容器，所以"新容器里没有旧行"
  //    **不能**证明旧分片停了——它可能正往一个已经摘下来的容器里继续追加
  //    （屏幕上看不见，但 CPU 照付；而且这正是评审那个反例的机制本身）。
  //    ⚠️ 断言的是"**没有再追加**"，不是"节点全被移除"：`clearHost()` 会
  //    `stopAppender()`（只置 `stopped`，与 `FileTree.stopAppenders` 同一条），
  //    已经追加的那 500 行**随旧容器一起被摘掉**，不必也不该再逐个 `remove`。
  const oldItems = host.children[0];
  assert.strictEqual(oldItems.className, 'doclist-items', '前置：应当有旧容器');
  const oldCount = oldItems.children.length;
  assert.strictEqual(oldCount, V_FIRST(), '前置：旧容器里应当正好是首片');

  // 同根、同代次、只换内容 ⇒ 旧分片必须自己停下来
  fake.listEntries = entries(1, 'new');
  await dl.refresh();
  await drain();

  assert.deepStrictEqual(rowPaths(host), ['/rootA/new/f0.md'],
    '可见容器里的内容不是新那一份 —— 正是评审给的那个 500 行反例');
  assert.strictEqual(rows(host).length, 1);
  assert.strictEqual(oldItems.children.length, oldCount,
    '旧分片在刷新之后**还在往旧容器里追加**（评审的 500 行反例：1 000 行的旧任务只画了首片，'
    + '剩下的必须停，⛔ 不该继续跑完）');
  dl.destroy();
});

test('⭐ 刷新**在途**时旧分片被调度 ⇒ 它必须回滚并停下（组合令牌的 `currentGen` 那一条）', async function () {
  // 这一格与上面那格不同：上格的"停"是 `clearHost()` 里的 `stopAppender()` 直接做到的；
  // 而 `refresh()` **先**推进令牌、**再**等回包 —— 回包在路上这段时间里，旧分片会照常被调度。
  // 此时唯一能拦住它的是"每个分片开头现取 `currentGen()`"（`chunked.js` 的约定）。
  // ⚠️ 只测"代次变了会停"是不够的：授权代次在这里**根本没变**。
  const fake = installFake();
  fake.install();
  await fake.reset();

  const host = makeHost();
  const dl = DocListUI.createDocList({ host: host, onOpenFile: function () {} });
  dl.setActive(true);

  fake.listEntries = entries(1000, 'old');
  await dl.refresh();
  const oldItems = host.children[0];
  assert.strictEqual(oldItems.children.length, V_FIRST(), '前置：旧容器里应当正好是首片');

  const gate = deferred();
  fake.gate = gate;
  fake.listEntries = entries(1, 'new');
  const pending = dl.refresh();
  // 只让出一轮宏任务：此刻新回包**还没到**，但旧分片那一片已经到期
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.strictEqual(oldItems.children.length, 0,
    '旧分片没有回滚 —— 组合令牌的 `currentGen` 没被用上（评审那个 500 行反例的机制）');

  gate.resolve();
  await pending;
  await drain();
  assert.deepStrictEqual(rowPaths(host), ['/rootA/new/f0.md']);
  dl.destroy();
});

test('切形态（setActive(false) → true）：停分片、清 DOM，切回来用同一份清单补画（⛔ 不重拉）', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset();

  const host = makeHost();
  const dl = DocListUI.createDocList({ host: host, onOpenFile: function () {} });
  dl.setActive(true);
  fake.listEntries = entries(700, 'a');
  await dl.refresh();
  const calls = fake.calls;

  dl.setActive(false);              // 切到树形态
  assert.strictEqual(rows(host).length, 0, '不可见之后容器里还留着行（隐藏的 700 行只会多付一次 GC）');
  await drain();
  assert.strictEqual(rows(host).length, 0, '停掉之后旧分片又追加上来了');

  dl.setActive(true);               // 切回列表形态
  await drain();
  assert.strictEqual(rows(host).length, 700, '切回来没有用同一份清单补画');
  assert.strictEqual(fake.calls, calls, '切形态不该重新拉一次清单');
  dl.destroy();
});

test('不可见时刷新：照常回调 `onResult`（树过滤要用判据），但**不建 DOM**', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset();

  const host = makeHost();
  let got = null;
  const dl = DocListUI.createDocList({
    host: host,
    onOpenFile: function () {},
    onResult: function (_result, dirs) { got = dirs; },
  });
  fake.listEntries = entries(50, 'a');
  await dl.refresh();
  assert.strictEqual(got instanceof Set, true, '不可见时也必须回调（树要 `keep_dirs`）');
  assert.strictEqual(got.has('/rootA/d'), true);
  assert.strictEqual(rows(host).length, 0, '不可见却画了 DOM（5000 行白画）');
  dl.destroy();
});

test('提交判据：后端回了个**旧请求号** ⇒ 一条都不画（同根刷新的迟到回包）', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset();

  const host = makeHost();
  let committed = 0;
  const dl = DocListUI.createDocList({
    host: host,
    onOpenFile: function () {},
    onResult: function () { committed += 1; },
  });
  dl.setActive(true);
  fake.reqDelta = -1;              // 回包回的是上一个请求号
  fake.listEntries = entries(3, 'stale');
  await dl.refresh();
  await drain();
  assert.strictEqual(rows(host).length, 0, '旧请求号的回包落到了屏上');
  assert.strictEqual(committed, 0, '旧请求号的回包触发了 `onResult`');
  dl.destroy();
});

test('提交判据：切根后的回包（`gen` 不同）⇒ 一条都不画', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset();

  const host = makeHost();
  const dl = DocListUI.createDocList({ host: host, onOpenFile: function () {} });
  dl.setActive(true);
  fake.genDelta = -1;
  fake.listEntries = entries(3, 'oldroot');
  await dl.refresh();
  await drain();
  assert.strictEqual(rows(host).length, 0);
  dl.destroy();
});

test('卸载之后：迟到的回包什么都不做，也不抛', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset();

  const host = makeHost();
  const dl = DocListUI.createDocList({ host: host, onOpenFile: function () {} });
  dl.setActive(true);
  fake.listEntries = entries(20, 'a');
  const pending = dl.refresh();
  dl.destroy();
  await pending;
  await drain();
  assert.strictEqual(rows(host).length, 0);
  assert.strictEqual(dl.isAlive(), false);
  // 卸载之后再来一次也⛔ 不许复活
  await dl.refresh();
  assert.strictEqual(rows(host).length, 0);
});

test('上限与提示：`entries` 超过 `MAX_RENDER` 时只画到上限，并**常驻一条**"没画完"', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset();

  const host = makeHost();
  const DL = require('../../src/services/doclists.js');
  const dl = DocListUI.createDocList({ host: host, onOpenFile: function () {} });
  dl.setActive(true);
  fake.listEntries = entries(DL.MAX_RENDER + 5, 'big');
  await dl.refresh();
  await drain();
  assert.strictEqual(rows(host).length, DL.MAX_RENDER, '没有停在展示上限上');
  const ns = notes(host);
  assert.strictEqual(ns.length, 1, '截断必须**可见**（`INV-DOCS-04`）');
  assert.ok(ns[0].textContent.indexOf(String(DL.MAX_RENDER)) >= 0, '文案里没带"画了多少"');
  dl.destroy();
});

test('空清单：画一句空态（⛔ 不是一块空白）', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset();

  const host = makeHost();
  const dl = DocListUI.createDocList({ host: host, onOpenFile: function () {} });
  dl.setActive(true);
  fake.listEntries = [];
  await dl.refresh();
  assert.strictEqual(rows(host).length, 0);
  assert.strictEqual(notes(host).length, 1, '空清单没有可见说明');
  dl.destroy();
});

test('一行两段：点一行发的是那一行的 `real_path`（⛔ 不是拼接出来的路径）', async function () {
  const fake = installFake();
  fake.install();
  await fake.reset();

  const host = makeHost();
  const opened = [];
  const dl = DocListUI.createDocList({
    host: host,
    onOpenFile: function (p) { opened.push(p); },
  });
  dl.setActive(true);
  fake.listEntries = entries(1, 'a');
  await dl.refresh();
  const row = rows(host)[0];
  assert.ok(row, '前置：应该有一行');
  assert.strictEqual(row.title, '/rootA/a/f0.md', '悬停提示不是完整路径');
  row.handlers.click();
  assert.deepStrictEqual(opened, ['/rootA/a/f0.md']);
  dl.destroy();
});

/** `versions.js` 的首片长度（⛔ 不抄数字：那个常量只有一份实现）。 */
function V_FIRST() {
  return require('../../src/services/versions.js').CHUNK_FIRST;
}
