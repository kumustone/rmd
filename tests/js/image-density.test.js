// `bugs/0068`：`@2x` / `@3x` 的图要按**设计尺寸**显示。
//
// # 这一份要钉住什么
//
// 1. `densityOf` 只认**文件名末尾**的 `@2x`/`@3x`（大小写不敏感，忽略查询串）；
//    没有标记 ⇒ 返回 0，⛔ 不能"猜"。
// 2. `applyDensity` 把显示宽折成 `像素宽 ÷ N`；`naturalWidth` 为 0 时⛔ 不设宽
//    （设成 0 会把图压没，比"偏大"严重得多）。
// 3. **接线判据**：`renderImages` 造出来的真图，`width` 属性真的被设上了。
//    ⚠️ 只测纯函数会漏掉最可能出错的那步——`toReal` 里取的是 `realPath` 而不是 `src`。
//
// # 变异台账（2026-11-04 实跑，⛔ 别凭记忆改数字）
//
// | 变异 | 结果 |
// |---|---|
// | `densityOf` 恒返回 0 | ✅ 红「只认文件名末尾」「接线」两条 |
// | 正则不锚串尾（`/@([23])x\.[a-z0-9]+$/i` → `/@([23])x/i`） | ✅ 红「目录名里的标记不算」 |
// | 去掉取 basename 的 `pop()` | ⚠️ **不红**——正则用 `$` 锚在串尾，而 `[a-z0-9]+` 跨不过 `/`
//    ⇒ 目录名里的标记本来就匹配不上，`pop()` 只是把意图写明白（等价改法） |
// | `applyDensity` 把 ÷N 改回 ×1 | ✅ 红三条折半判据 |
// | `toReal` 不调 `applyDensity`（`dens` 写死 0） | ✅ 红「接线」那条 |
// | `applyDensity` 去掉 `px > 0` 守卫 | ⚠️ **单独改不红**：外层 `complete && naturalWidth > 0`
//    那条兜住了。⭐ **两条一起去掉**才 ✅ 红「宽度未知时⛔ 不设宽」
//    ⇒ ⛔ 别删掉其中一条以为另一条多余：没有判据看得见"剩下那条还在不在"
// | `toReal` 改用 `src` 取密度（本例两者同值） | ⚠️ 不红——**这一条不在判据里**：两者的**文件名**
//    必然相同 ⇒ 等价改法，⛔ 别为它硬造一条判据 |
// | ⚠️ 假 `<img>` 的 `width` 初值必须是 `null` | 用 `0` 时"没设过"与"设成 0"分不开，上面那条变异会装绿 |

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const S = require('../../src/services/session.js');
const IV = require('../../src/components/ImageView.js');

// ── 纯逻辑 ────────────────────────────────────────────────────────────────

test('densityOf：只认文件名末尾的 @2x / @3x', function () {
  assert.strictEqual(IV.densityOf('assets/architecture/02-read-path@2x.png'), 2);
  assert.strictEqual(IV.densityOf('a@3x.jpg'), 3);
  assert.strictEqual(IV.densityOf('/abs/路径/图@2x.PNG'), 2, '大小写不敏感');
  assert.strictEqual(IV.densityOf('a@2x.png?v=1'), 2, '查询串要忽略');
  assert.strictEqual(IV.densityOf('a@2x.png#frag'), 2, '片段要忽略');
});

test('densityOf：没有标记、@1x、目录名里的标记都不算', function () {
  assert.strictEqual(IV.densityOf('assets/architecture/01-overview.png'), 0);
  assert.strictEqual(IV.densityOf('a@1x.png'), 0, '@1x 就是一倍，不需要换算');
  assert.strictEqual(IV.densityOf('x@2x/图.png'), 0, '⭐ 标记在**目录**名上不算');
  assert.strictEqual(IV.densityOf('a@2x'), 0, '没有扩展名不算');
  assert.strictEqual(IV.densityOf(''), 0);
  assert.strictEqual(IV.densityOf(null), 0);
});

// ── 折半本身 ──────────────────────────────────────────────────────────────

/** 假 `<img>`：只实现 `applyDensity` 真正摸的那几个面。 */
function fakeImg(px, complete) {
  return {
    complete: !!complete,
    naturalWidth: px,
    /** ⚠️ 初值是 `null` 而不是 0：这样"没设过"与"设成 0"才分得开（M3 变异要能打红）。 */
    width: null,
    /** ⭐ 2026-11-05：尺寸没定下来之前 `visibility: hidden`（见 `applyDensity`）。 */
    style: {},
    listeners: [],
    events: [],
    addEventListener: function (ev, fn) {
      this.listeners.push(fn);
      this.events.push(ev);
    },
  };
}

test('applyDensity：解码完成就折半，奇数像素四舍五入', function () {
  const img = fakeImg(1100, true);
  IV.applyDensity(img, 2);
  assert.strictEqual(img.width, 550);
  assert.notStrictEqual(img.style.visibility, 'hidden', '已经解码的图一刻都不该藏');
  const odd = fakeImg(1101, true);
  IV.applyDensity(odd, 2);
  assert.strictEqual(odd.width, 551, '四舍五入，⛔ 不是截断成 550');
  const three = fakeImg(900, true);
  IV.applyDensity(three, 3);
  assert.strictEqual(three.width, 300);
});

test('applyDensity：还没解码时等 load，且只等一次（load / error 各一次）', function () {
  const img = fakeImg(0, false);
  IV.applyDensity(img, 2);
  assert.strictEqual(img.width, null, 'load 之前不动它');
  assert.deepStrictEqual(img.events, ['load', 'error'], 'load ＋ error 各挂一次（失败也要露出来）');
  assert.strictEqual(img.style.visibility, 'hidden',
    '⭐ 解码前必须藏着：`@2x` 图此刻按像素尺寸排，会先撑满整列再缩回去');
  img.naturalWidth = 2672;
  img.listeners[0]();
  assert.strictEqual(img.width, 1336);
  assert.strictEqual(img.style.visibility, '', 'load 之后必须显出来');
});

test('applyDensity：解码失败也要显出来（⛔ 不留永远隐形的节点）', function () {
  const img = fakeImg(0, false);
  IV.applyDensity(img, 2);
  assert.strictEqual(img.style.visibility, 'hidden');
  img.listeners[1]();                       // error
  assert.strictEqual(img.style.visibility, '');
  assert.strictEqual(img.width, null, '⛔ 失败时不设宽');
});

test('applyDensity：宽度未知时⛔ 不设宽（不能把图压成 0）', function () {
  const img = fakeImg(0, true);
  IV.applyDensity(img, 2);
  assert.strictEqual(img.width, null, '⛔ 不能设成 0');
  assert.notStrictEqual(img.style.visibility, 'hidden', '`complete` 就不藏（坏图也不藏）');
});

test('applyDensity：没有密度标记时不换算', function () {
  const img = fakeImg(1100, true);
  IV.applyDensity(img, 0);
  assert.strictEqual(img.width, null, '⛔ 传 0 必须是空操作');
  const one = fakeImg(1100, true);
  IV.applyDensity(one, 1);
  assert.strictEqual(one.width, null, '@1x 不折半');
});

// ── 接线：renderImages 真的把 width 设上了 ────────────────────────────────

/** 最小假 DOM（同 `image-cache.test.js` 的做法，只多一个 `width`）。 */
function makeEl(tag, attrs) {
  const node = {
    tagName: String(tag).toUpperCase(),
    attrs: Object.assign({}, attrs || {}),
    dataset: {},
    className: '',
    width: 0,
    children: [],
    parent: null,
    /** ⭐ 假 `data:` URL 一挂上就算解码好了。 */
    complete: true,
    naturalWidth: 0,
    draggable: true,
    tabIndex: -1,
    isConnected: true,
    getAttribute: function (n) {
      return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
    },
    setAttribute: function (n, v) {
      this.attrs[n] = String(v);
    },
    addEventListener: function (ev, fn) {
      if (ev === 'load') fn();
    },
    closest: function () {
      return null;
    },
    replaceWith: function (other) {
      const p = this.parent;
      if (!p) return;
      p.children.splice(p.children.indexOf(this), 1, other);
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
    classList: { add: function () {} },
  };
  return node;
}

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise(function (r) { setImmediate(r); });
}

test('接线：本地图的 width 落在真节点上（值 = 像素宽 ÷ 密度）', async function () {
  const realWidths = { 'a@2x.png': 1100, 'b.png': 1100 };
  const originalCreate = global.document && global.document.createElement;
  global.document = {
    createElement: function (tag) {
      const el = makeEl(tag);
      // ⚠️ 只给 `<img>` 装像素尺寸；`src` 一挂上（`setAttribute` 不走这条路）——
      //    这里用 defineProperty 模拟"解码后才知道"的那一瞬。
      if (el.tagName === 'IMG') {
        el.complete = false;
        el.addEventListener = function (ev, fn) {
          if (ev === 'load') this.__onload = fn;
        };
      }
      return el;
    },
  };
  const originalRead = S.readAsset;
  const origPut = IV.clearAssetCache;
  origPut.call(IV);
  S.readAsset = function (src) {
    return Promise.resolve({ data_url: 'data:image/png;base64,AA', real_path: '/docs/' + src, __w: realWidths[src] });
  };

  try {
    const doc = makeEl('div');
    const a = makeEl('img', { src: 'a@2x.png' });
    const b = makeEl('img', { src: 'b.png' });
    doc.appendChild(a);
    doc.appendChild(b);
    doc.querySelectorAll = function () {
      return doc.children.filter(function (c) { return c.tagName === 'IMG'; });
    };

    IV.renderImages(doc, { docKey: '/docs/x.md' });
    await flush();

    const imgs = doc.children.filter(function (c) { return c.tagName === 'IMG'; });
    assert.strictEqual(imgs.length, 2, '两张图都要被换进真节点');
    for (const im of imgs) {
      // 后端回来的像素尺寸：按文件名查表（模拟各自的位图宽度）
      const px = (im.dataset.realPath || '').indexOf('@2x') >= 0 ? realWidths['a@2x.png'] : 1100;
      im.naturalWidth = px;
      if (im.__onload) im.__onload();
    }
    const byPath = {};
    for (const im of imgs) byPath[im.dataset.realPath] = im;
    assert.strictEqual(byPath['/docs/a@2x.png'].width, 550, '⛔ 接线没接上（toReal 没调 applyDensity）');
    assert.strictEqual(byPath['/docs/b.png'].width, 0, '没有 @2x 的图⛔ 不许被动过');
  } finally {
    S.readAsset = originalRead;
    if (originalCreate) global.document.createElement = originalCreate;
  }
});
