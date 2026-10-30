// `src/components/ImageView.js` 的**图片缓存**判据（2026-10-29 代码评审第 6 条）。
//
// # 这一份为什么必须存在
//
// 缓存的三条边界（`createAssetCache` 的注释）**全部静默**：
//   · 键里漏了文档身份 ⇒ A 文档的图贴到 B 文档里（**错的内容**，比慢严重得多）；
//   · 失败也缓存 ⇒ 用户补授权之后那张图**永远**是占位；
//   · 命中不重建属性 ⇒ `dataset.realPath` / `rmd-zoomable` / `aria-label` 消失，
//     缩略图点不开预览、切语言也修不好——屏幕上看起来只是"这张图不能点"。
// ⇒ 每一条都要有判据，而且**命中那条必须真的走一遍 `renderImages`**（只测 `createAssetCache`
//   是测不到"命中就不发 IPC"的，那正是评审第 6 条要的那个收益）。
//
// ⚠️ 这里用**假 DOM**（同 `live-blocks.test.js` 的做法）：`renderImages` 只用到
// `querySelectorAll` / `createElement` / `getAttribute` / `replaceWith` / `closest` /
// `decode`。⛔ 不引 jsdom——判据要说的是"我们的逻辑对不对"，不是"浏览器对不对"。
// ⚠️ `S.readAsset` 是**桩子**：真那一条会走 IPC（`check_readable` ＋ 读盘 ＋ base64），
// 在 node 里跑不起来，而这个判据关心的是"**调了几次**"。
//
// # 变异台账（2026-10-29 实跑，⛔ 别凭记忆改数字）
//
// | 变异 | 结果 |
// |---|---|
// | 摘掉命中分支（`ASSETS.get(cacheKey)` → `null`） | ✅ 只红「命中：…不发 IPC」（第 7 条） |
// | 缓存键去掉 `docKey`（**只**改这一处） | ⚠️ **不红** —— 归类「改法等价」：换文档时那张整表作废（`docKey !== cacheDocKey ⇒ clear`）已经兜住了，两条机制任一都足以防串文档 |
// | 键去掉 `docKey` **且** 摘掉整表作废 | ✅ 红两条：「键里带文档身份」＋「换文档要清表」那条源码判据 |
// ⇒ ⛔ **别删掉其中一条以为另一条多余**：它们互为兜底，只留一条时没有任何判据看得见剩下的那条还在不在。


'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../../src/services/session.js');
// ⚠️ 必须在 `ImageView.js` **之前/之后都行**（IIFE 取的是同一个 `module.exports` 对象），
//   但为了让读者一眼看出"这份文件替换了它"，放在前面。
const realReadAsset = S.readAsset;
const IV = require('../../src/components/ImageView.js');

// ── 假 DOM ────────────────────────────────────────────────────────────────

let SEQ = 0;

/** 造一个假元素。只实现 `renderImages` 真正摸到的那几个面。 */
function makeEl(tag, attrs) {
  const node = {
    __id: ++SEQ,
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    attrs: Object.assign({}, attrs || {}),
    dataset: {},
    className: '',
    children: [],
    parent: null,
    draggable: true,
    tabIndex: -1,
    get isConnected() {
      return true;
    },
    getAttribute: function (n) {
      return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
    },
    setAttribute: function (n, v) {
      this.attrs[n] = String(v);
    },
    addEventListener: function () {},
    /** ⚠️ 只支持 `a[href]` 这一种选择器——产品里也只用这一种（`design/0018` §2.4）。 */
    closest: function (sel) {
      const want = String(sel).replace(/\[href\]$/, '').toLowerCase();
      const needHref = String(sel).indexOf('[href]') >= 0;
      for (let n = this; n; n = n.parent) {
        if (String(n.tagName).toLowerCase() !== want) continue;
        if (needHref && n.getAttribute('href') === null) continue;
        return n;
      }
      return null;
    },
    replaceWith: function (other) {
      const p = this.parent;
      if (!p) return;
      const i = p.children.indexOf(this);
      assert.ok(i >= 0, '假 DOM：被替换的节点不在父节点里');
      p.children.splice(i, 1, other);
      other.parent = p;
      this.parent = null;
    },
    appendChild: function (c) {
      c.parent = this;
      this.children.push(c);
      return c;
    },
    decode: function () {
      return Promise.resolve();
    },
  };
  node.classList = {
    add: function (c) {
      node.className = (node.className ? node.className + ' ' : '') + c;
    },
  };
  return node;
}

/** 一个正文容器，`querySelectorAll('img')` 只认**当前**那一批图。 */
function makeDoc(imgs) {
  const doc = makeEl('div');
  for (const img of imgs) doc.appendChild(img);
  doc.querySelectorAll = function (sel) {
    assert.strictEqual(String(sel).toLowerCase(), 'img', '假 DOM 只实现了 img 这一种查询');
    return doc.children.filter(function (c) {
      return c.tagName === 'IMG';
    });
  };
  return doc;
}

/** 让 `readAsset(...).then(...)` 那一串微任务跑完（两轮足够：then ＋ settleImage 的 decode）。 */
async function flush() {
  for (let i = 0; i < 4; i++) await new Promise(function (r) { setImmediate(r); });
}

/** 装一个假 `readAsset`，返回**调用记录**。 */
function stubReadAsset(impl) {
  const calls = [];
  S.readAsset = function (src) {
    calls.push(src);
    return impl(src, calls.length);
  };
  return calls;
}

/** 每一条判据都从干净的表开始（`ASSETS` / `cacheDocKey` 是模块级状态）。 */
function reset() {
  IV.clearAssetCache();
  global.document = {
    createElement: function (tag) {
      return makeEl(tag);
    },
  };
}

// ── createAssetCache：纯逻辑 ──────────────────────────────────────────────

test('缓存：命中拿回同一份内容，未命中回 null', function () {
  const c = IV.createAssetCache({ maxEntries: 4, maxBytes: 1000, ttlMs: 0, now: function () { return 0; } });
  c.put('k', 'data:image/png;base64,AAA', '/p/a.png');
  const hit = c.get('k');
  assert.deepStrictEqual([hit.url, hit.realPath], ['data:image/png;base64,AAA', '/p/a.png']);
  assert.strictEqual(c.get('没有这条'), null);
  assert.strictEqual(c.size(), 1);
});

test('缓存：TTL 到期即失效，且**顺手把条目删掉**（⛔ 不是留着下次再判）', function () {
  let clock = 0;
  const c = IV.createAssetCache({ maxEntries: 4, maxBytes: 1000, ttlMs: 1000, now: function () { return clock; } });
  c.put('k', 'data:x', '/p/a.png');
  clock = 999;
  assert.ok(c.get('k'), '还没到期');
  clock = 1000;
  assert.strictEqual(c.get('k'), null, '到点算过期（边界取 >=）');
  assert.strictEqual(c.size(), 0, '过期条目必须真的从表里消失，否则 LRU 淘汰会先淘汰别人');
  assert.strictEqual(c.bytes(), 0);
});

test('缓存：条数上限按 LRU 淘汰，**命中会延长寿命**', function () {
  const c = IV.createAssetCache({ maxEntries: 2, maxBytes: 1000, ttlMs: 0, now: function () { return 0; } });
  c.put('a', 'data:a', '/a');
  c.put('b', 'data:b', '/b');
  c.get('a'); // ⭐ 摸一下 ⇒ 变成最近用的那条
  c.put('c', 'data:c', '/c');
  assert.strictEqual(c.get('b'), null, '最久没用的那条被淘汰');
  assert.ok(c.get('a'));
  assert.ok(c.get('c'));
  assert.strictEqual(c.size(), 2);
});

test('缓存：字节上限按 LRU 淘汰；**单张就超预算 ⇒ 根本不进表**', function () {
  const c = IV.createAssetCache({ maxEntries: 10, maxBytes: 20, ttlMs: 0, now: function () { return 0; } });
  c.put('a', 'data:12345', '/a'); // 10
  c.put('b', 'data:12345', '/b'); // 10
  c.put('c', 'data:12345', '/c'); // 10 ⇒ 必须挤掉 a
  assert.strictEqual(c.get('a'), null);
  assert.deepStrictEqual([c.size(), c.bytes()], [2, 20]);

  const big = IV.createAssetCache({ maxEntries: 10, maxBytes: 5, ttlMs: 0, now: function () { return 0; } });
  big.put('x', 'data:12345', '/x');
  assert.strictEqual(big.size(), 0, '⛔ 不许"先塞进去再立刻淘汰"——那会把整个表冲光');
});

test('缓存：空的键 / 空的 URL 一律不收（缓存里放一条空 URL 会让那张图变成破图）', function () {
  const c = IV.createAssetCache({ maxEntries: 4, maxBytes: 1000, ttlMs: 0, now: function () { return 0; } });
  c.put('', 'data:x', '/a');
  c.put('k', '', '/a');
  c.put(null, 'data:x', '/a');
  assert.strictEqual(c.size(), 0);
});

test('缓存：clear() 之后条数与字节都归零', function () {
  const c = IV.createAssetCache({ maxEntries: 4, maxBytes: 1000, ttlMs: 0, now: function () { return 0; } });
  c.put('a', 'data:aaa', '/a');
  c.clear();
  assert.deepStrictEqual([c.size(), c.bytes()], [0, 0]);
});

// ── renderImages：缓存真正起作用的那几条 ─────────────────────────────────

test('命中：同一个文档第二次挂载**不发 IPC、不闪占位**，且属性重建得一模一样', async function () {
  reset();
  let calls = stubReadAsset(function (src) {
    return Promise.resolve({ data_url: 'data:image/png;base64,' + src, real_path: '/assets/' + src });
  });

  // ① 第一次：真读盘
  const doc1 = makeDoc([makeEl('img', { src: 'a.png', alt: 'A' })]);
  const stat1 = IV.renderImages(doc1, { docKey: '/doc/a.md' });
  await flush();
  assert.deepStrictEqual(calls, ['a.png'], '第一次必须读盘');
  assert.deepStrictEqual([stat1.loaded, stat1.cached], [1, 0]);
  assert.strictEqual(doc1.children.length, 1);
  assert.strictEqual(doc1.children[0].tagName, 'IMG');
  assert.strictEqual(doc1.children[0].dataset.realPath, '/assets/a.png');

  // ② 第二次：同一份文档（预览重渲 / 提交后整篇重挂就是这条路）
  const doc2 = makeDoc([makeEl('img', { src: 'a.png', alt: 'A' })]);
  const stat2 = IV.renderImages(doc2, { docKey: '/doc/a.md' });
  // ⭐ 命中是**同步**的 ⇒ 此刻必须已经是一张真 `<img>`，⛔ 不是一个"正在读"的占位
  assert.strictEqual(doc2.children.length, 1);
  assert.strictEqual(doc2.children[0].tagName, 'IMG', '命中不许先换占位再换回来（那是用户看见的闪烁）');
  assert.strictEqual(doc2.children[0].dataset.realPath, '/assets/a.png', '命中也要重建 dataset.realPath');
  assert.match(doc2.children[0].className, /rmd-zoomable/, '命中也要重建缩放标记');
  // ⚠️ node 里没有 `window.rmd.i18n` ⇒ `t()` 是**恒等**的 ⇒ 拿到的是字典**键**。
  //    ⛔ 这里判的**不是译文**，是"`toReal` 真的跑过、把 alt 那一支接上了"。
  assert.strictEqual(doc2.children[0].getAttribute('aria-label'), 'img.view-with-alt');
  await flush();
  assert.deepStrictEqual(calls, ['a.png'], '⛔ 命中还在发 IPC —— 缓存等于没做');
  assert.deepStrictEqual([stat2.loaded, stat2.cached], [1, 1]);
});

test('键里带文档身份：同一个 src 换一份文档 ⇒ 必须重新读盘（⛔ 不许把 A 的图贴进 B）', async function () {
  reset();
  const calls = stubReadAsset(function (src, n) {
    return Promise.resolve({ data_url: 'data:image/png;base64,#' + n + ':' + src, real_path: '/d' + n + '/' + src });
  });

  IV.renderImages(makeDoc([makeEl('img', { src: 'logo.png' })]), { docKey: '/doc/a.md' });
  await flush();
  assert.deepStrictEqual(calls, ['logo.png']);

  const doc2 = makeDoc([makeEl('img', { src: 'logo.png' })]);
  IV.renderImages(doc2, { docKey: '/doc/b.md' });
  await flush();
  assert.deepStrictEqual(calls, ['logo.png', 'logo.png'], '换了文档 ⇒ 必须重新读那一份同名文件');
  assert.strictEqual(doc2.children[0].dataset.realPath, '/d2/logo.png', '拿到的必须是 B 文档自己那一张');
});

test('失败不缓存：未授权那张图**每次**都要重新试（用户可能刚补了授权）', async function () {
  reset();
  const calls = stubReadAsset(function () {
    const e = new Error('未授权');
    e.kind = 'not_authorized';
    return Promise.reject(e);
  });

  const doc1 = makeDoc([makeEl('img', { src: 'secret.png' })]);
  const stat1 = IV.renderImages(doc1, { docKey: '/doc/a.md' });
  await flush();
  assert.strictEqual(stat1.unauthorized, 1);
  assert.strictEqual(stat1.cached, 0);

  const doc2 = makeDoc([makeEl('img', { src: 'secret.png' })]);
  const stat2 = IV.renderImages(doc2, { docKey: '/doc/a.md' });
  await flush();
  assert.strictEqual(calls.length, 2, '⛔ 失败被缓存了 —— 补上授权之后这张图会永远是占位');
  assert.strictEqual(stat2.unauthorized, 1);
  assert.strictEqual(stat2.cached, 0);
});

test('clearAssetCache() 之后同一个文档也要重新读盘', async function () {
  reset();
  const calls = stubReadAsset(function (src) {
    return Promise.resolve({ data_url: 'data:image/png;base64,' + src, real_path: '/assets/' + src });
  });
  IV.renderImages(makeDoc([makeEl('img', { src: 'a.png' })]), { docKey: '/doc/a.md' });
  await flush();
  IV.clearAssetCache();
  IV.renderImages(makeDoc([makeEl('img', { src: 'a.png' })]), { docKey: '/doc/a.md' });
  await flush();
  assert.strictEqual(calls.length, 2, '清表之后必须重新读（磁盘变更 / 换根就是靠这一条）');
});

test('落定信号：命中的那一批**也要**进 pending，否则 onSettled 少一跳', async function () {
  reset();
  stubReadAsset(function (src) {
    return Promise.resolve({ data_url: 'data:image/png;base64,' + src, real_path: '/assets/' + src });
  });
  IV.renderImages(makeDoc([makeEl('img', { src: 'a.png' })]), { docKey: '/doc/a.md' });
  await flush();

  let settled = 0;
  IV.renderImages(makeDoc([makeEl('img', { src: 'a.png' })]), {
    docKey: '/doc/a.md',
    onSettled: function () {
      settled += 1;
    },
  });
  await flush();
  assert.strictEqual(settled, 1, '命中那一批必须有自己的"落定"（`design/0017` 的阅读进度靠它）');
});

// ── 源码级判据：接线（`main.js` 不进 node 的判据，只能这样守） ───────────

const ROOT = path.join(__dirname, '..', '..');
const IV_SRC = fs.readFileSync(path.join(ROOT, 'src/components/ImageView.js'), 'utf8');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');

test('接线：`main.js` 调 `renderImages` 时必须传 `docKey`', function () {
  const m = MAIN_SRC.match(/ImageView\.renderImages\(doc,\s*\{[\s\S]{0,600}?\}\)/);
  assert.ok(m, '⛔ 找不到 `ImageView.renderImages(doc, {…})` 那个调用点');
  assert.match(m[0], /docKey:\s*payload\.real_path/, '⛔ 少了 docKey ⇒ 缓存键退化成只认 src（会贴错图）');
});

test('接线：换根与盘上变更两处都要清表', function () {
  const hits = MAIN_SRC.match(/ImageView\.clearAssetCache\(\)/g) || [];
  assert.ok(hits.length >= 2, '⛔ 只在 ' + hits.length + ' 处清表：盘上变更（`reloadCurrentDocument`）与换根（`onChooseDirectory`）都要');
});

test('接线：`renderImages` 里换文档要清表，且失败分支**不许**写缓存', function () {
  assert.match(IV_SRC, /if \(docKey !== cacheDocKey\) \{\s*ASSETS\.clear\(\);/,
    '⛔ 文档身份变了却不腾表 ⇒ 旧文档的 base64 会一直占着上限');
  const putAt = IV_SRC.indexOf('ASSETS.put(');
  const catchAt = IV_SRC.indexOf('.catch(function (err)', putAt);
  assert.ok(putAt >= 0, '⛔ 找不到 `ASSETS.put(`');
  assert.ok(catchAt > putAt, '⛔ `ASSETS.put` 出现在失败分支之后 —— 失败被缓存了');
  assert.strictEqual((IV_SRC.match(/ASSETS\.put\(/g) || []).length, 1, '写缓存的点只该有一处');
});

// ── 收尾：把桩子还回去（同一个文件里别的判据不该看见它） ────────────────

test('收尾：还原 `readAsset`', function () {
  S.readAsset = realReadAsset;
  assert.strictEqual(typeof S.readAsset, 'function');
});
