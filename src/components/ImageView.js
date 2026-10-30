// 正文里的图片 —— `design/0003` §2.1.2 (3) 路线 A + §2.1.4 的两条占位规则。
//
// # 为什么图片要过一次 IPC
//
// V1 采用**路线 A**：`read_asset(src)` → 后端 `check_readable` → 返回 `data:` URL。
// 理由是 R2 要的「**统一入口**」：路线 B（`protocol-asset`）会把授权变成**两个真值**，
// 而"两个真值必须同步"**没有自动化防线**——它靠人记得。
// ⚠️ 代价（IPC + base64 ≈ +33%）是可量化的，正是 **U6** 要量的东西；留批 2。
//
// # ⛔ 前端**不拼路径**
//
// 递过去的是文档里那个**原始 `src` 字符串**，由后端用 `doc_dir.join(src)` 解析。
// 前端连"文档在哪"都不该自己算——它只把字符串原样递回去（`INV-TREE-01` 的同一条精神）。
//
// # ⚠️ 三种**不同**的拒绝，三种**不同**的说法（§7 步骤 18 的隐蔽断言）
//
// | 后端 kind | 文案 | 为什么不能混 |
// |---|---|---|
// | `not_authorized` | 「未授权其所在目录」+ 一键授权 | 这是**我们的安全策略**在起作用 |
// | `not_found` | 「文件不存在」 | 这是**用户的文件真的没了** |
// | `io` | 后端给的具体原因（含"超过上限"） | 不是策略也不是缺失 |
//
// ⛔ **禁止静默破图**：用户会以为文件坏了 / 是 bug，而实际上是我们挡住了它。
//
// # 远程图片（`https://`）：V1 **不加载**（2026-10-13 评审通过，§9）
//
// 它走 WebView 自身的网络，**不经过**任何授权模型——加载它等于
// "打开一份文档 = 向文档作者指定的主机发起一次请求"，是隐私与追踪面。
// 呈现为**占位 + 可点开**（点了才加载，且那一次是用户自己的动作）。
// ⚠️⚠️ **每个文件都包一层 IIFE**——这**不是**风格问题，是必须的。
//
// 经典脚本（⛔ 不是 ES module）的顶层 `const` **共用一个全局词法作用域**：
// 两个文件都写 `const api = …`（或 `const V` / `const S` / `const T`）时，
// 后加载的那个文件**整个不执行**（解析期 `SyntaxError`），
// 而错误只出现在 WebView 的控制台里——本项目看不到它。
//
// 表现：**一个永远开着的空白窗口**，stderr 里连一条错误都没有。
// 2026-10-13 实施 `design/0003` 时真踩到了：7 个模块几乎全被
// `const V` / `const api` 撞掉，冒烟挂在那里一动不动。
//
// ⇒ 双导出（浏览器挂 `window.rmd.*` / node 挂 `module.exports`）**必须在 IIFE 里**。
(function () {
  'use strict';

  const T = (typeof module !== 'undefined' && module.exports) ? require('../services/tauri.js') : window.rmd.tauri;
  const S = (typeof module !== 'undefined' && module.exports) ? require('../services/session.js') : window.rmd.session;
  // ⭐ `design/0025`：可见文案走字典。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) || null;
  const t = I18N ? I18N.t : function (key) { return key; };

  /** 这个 `src` 是不是"要联网"的。 */
  function isRemote(src) {
    return /^(https?:)?\/\//i.test(String(src || '').trim());
  }

  /**
   * 这条拒绝该怎么说给用户听（§7 步骤 18 的全部意义就在这张表里）。
   *
   * ⭐ 返回的是**配方**（`{key, vars}`），⛔ 不是算好的那句话（`design/0025` §2.5.1 ②）：
   *    占位块建好之后**不会再重画**，而切语言时要能按同一份配方重贴一次。
   *    在这里先 `t()` 就等于把语言冻在这张图失败的那一刻。
   */
  function wordingFor(err, src) {
    if (err && err.kind === 'not_authorized') {
      return { spec: { key: 'img.unauthorized', vars: { src: src } }, action: 'authorize' };
    }
    if (err && err.kind === 'not_found') {
      return { spec: { key: 'img.missing', vars: { src: src } }, action: null };
    }
    // ⚠️ "有原因"与"没原因"是**两条键**，⛔ 不在 `vars` 里塞一个算好的中文兜底
    //    （那会把语言冻在这一刻，切语言后这句话仍是旧语言）；也⛔ 不在源码里拼冒号（§2.2.1）。
    const why = (err && (err.message || err.wording)) || '';
    return why
      ? { spec: { key: 'img.unreadable', vars: { src: src, msg: why } }, action: null }
      : { spec: { key: 'img.unreadable-nomsg', vars: { src: src } }, action: null };
  }

  /**
   * ⭐ 占位块的"重贴配方"登记表（`design/0025` §2.5.1 ②）：
   * 这些节点属于**已提交的正文**，切语言时没有谁会把它们重新画一遍。
   * ⚠️ 只留**还在文档里**的那些（`isConnected`）——文档一换，它们就成垃圾了。
   */
  const placeholderSpecs = [];

  /** 按配方算一句话。 */
  function specText(spec) {
    return t(spec.key, spec.vars);
  }

  /** 可缩放图片的 `aria-label` 登记表（同样属于"已提交正文、不会重画"那一类）。 */
  const zoomableSpecs = [];

  /** 切语言时重贴所有还活着的占位块与图片标签（`subscribe` 那一路）。 */
  function relabel() {
    let k = 0;
    for (let i = 0; i < placeholderSpecs.length; i++) {
      const r = placeholderSpecs[i];
      if (!r.label || !r.label.isConnected) continue;
      r.label.textContent = specText(r.spec);
      if (r.btn && r.action) r.btn.textContent = specText(r.action);
      placeholderSpecs[k++] = r;
    }
    placeholderSpecs.length = k;
    let m = 0;
    for (let j = 0; j < zoomableSpecs.length; j++) {
      const z = zoomableSpecs[j];
      if (!z.el || !z.el.isConnected) continue;
      z.el.setAttribute('aria-label', t(z.alt ? 'img.view-with-alt' : 'img.view', { alt: z.alt }));
      zoomableSpecs[m++] = z;
    }
    zoomableSpecs.length = m;
  }

  if (I18N) I18N.subscribe(relabel);

  /**
   * 造一个占位块（替换掉那个会变成破图的 `<img>`）。
   *
   * @param {Element} img 原图
   * @param {{key:string, vars:object}} spec 说明那句的配方
   * @param {{key:string, vars:object}|null} action 按钮那句的配方（`null` = 没有按钮）
   */
  function makePlaceholder(img, spec, action) {
    const box = document.createElement('span');
    box.className = 'img-placeholder';
    box.dataset.src = img.getAttribute('src') || '';
    const label = document.createElement('span');
    label.className = 'img-placeholder-text';
    label.textContent = specText(spec);
    box.appendChild(label);
    let btn = null;
    if (action) {
      btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = specText(action);
      box.appendChild(btn);
      box._button = btn;
    }
    // ⭐ 登记"怎么重算"（见 `relabel()`）；⚠️ 登记的是**配方**，⛔ 不是算好的字符串。
    placeholderSpecs.push({ label: label, btn: btn, spec: spec, action: action });
    return box;
  }

  /**
   * ⭐ **本地图片的 `data:` URL 缓存**（2026-10-29 代码评审第 6 条）。
   *
   * ## 为什么需要它
   *
   * 原来每挂载一次正文，**每一张**本地图都重新走一遍 `readAsset`（`check_readable` ＋
   * 读文件 ＋ base64），并伴随一次占位闪烁。分栏预览时代这是**去抖**的，代价被挡住；
   * `design/0047` 的就地编辑让"每离开一块就整篇重渲" ⇒ 频次高一个量级，
   * 一份 20 张图的文档改一个字就读 20 遍盘。
   *
   * ## 三条边界（⛔ 别把任何一条读成"可以不遵守"）
   *
   * 1. ⛔ **只缓存成功**。失败（未授权 / 不存在 / io）**不缓存**：授权是可以在这一次
   *    会话里补上的（`INV-FS-03` 的"重新授权"），缓存一个失败就会让它永远显示占位。
   * 2. ⚠️ **键里带文档身份**（`docKey`）：同一个 `src` 在两份文档里指的是**两个文件**
   *    （后端用 `doc_dir.join(src)` 解析）。钥匙只认 `src` 会让 A 文档的图出现在 B 里——
   *    那是**错的内容**，比慢严重得多。
   * 3. ⚠️ **有 TTL（5 分钟）与两道上限**：图片可能在外部被改掉，而我们这里没有任何
   *    失效通知（磁盘事件只到目录粒度）。⇒ 缓存是**加速**，⛔ 不是"文件内容的事实来源"。
   *
   * ⚠️ 它**不是**第二个真值：命中缓存跳过的只有读盘那一跳，`<img>` 上的
   * `dataset.realPath` / `rmd-zoomable` / `aria-label` 全部照原样重建（见 `toReal`）。
   *
   * @param {{maxEntries?:number, maxBytes?:number, ttlMs?:number, now?:Function}} [opts]
   */
  function createAssetCache(opts) {
    const o = opts || {};
    const maxEntries = o.maxEntries > 0 ? o.maxEntries : 24;
    const maxBytes = o.maxBytes > 0 ? o.maxBytes : 32 * 1024 * 1024;
    const ttlMs = typeof o.ttlMs === 'number' && o.ttlMs >= 0 ? o.ttlMs : 5 * 60 * 1000;
    const now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    /** 插入顺序 = LRU 顺序（Map 保序；命中时重插一次把它挪到末尾）。 */
    const map = new Map();
    let total = 0;

    function drop(key) {
      const e = map.get(key);
      if (!e) return;
      map.delete(key);
      total -= e.bytes;
    }

    function get(key) {
      const e = map.get(key);
      if (!e) return null;
      // ⚠️ 边界取 `>=`：走满 TTL 就算过期（判据在 `tests/js/image-cache.test.js`）。
      if (ttlMs > 0 && now() - e.at >= ttlMs) {
        drop(key);
        return null;
      }
      map.delete(key);
      map.set(key, e);
      return e;
    }

    function put(key, url, realPath) {
      if (typeof key !== 'string' || key === '') return;
      if (typeof url !== 'string' || url === '') return;
      // `data:` URL 是 base64 ⇒ 字符串长度就是内存占用（UTF-16 码元，实际上限更宽）
      const bytes = url.length;
      // ⚠️ 单张就超总预算 ⇒ 不缓存（⛔ 不许"先塞进去再立刻淘汰"，那会把整个缓存冲光）
      if (bytes > maxBytes) return;
      drop(key);
      map.set(key, { url: url, realPath: realPath, bytes: bytes, at: now() });
      total += bytes;
      while (map.size > maxEntries || total > maxBytes) {
        const first = map.keys().next();
        if (first.done) break;
        drop(first.value);
      }
    }

    function clear() {
      map.clear();
      total = 0;
    }

    return {
      get: get,
      put: put,
      clear: clear,
      size: function () { return map.size; },
      bytes: function () { return total; },
    };
  }

  /** 全局那一份（`renderImages` 用）；⚠️ 参数改动会同时改变内存占用，见上面三条边界。 */
  const ASSETS = createAssetCache({ maxEntries: 24, maxBytes: 32 * 1024 * 1024, ttlMs: 5 * 60 * 1000 });
  /** 上一份文档的身份；换文档 ⇒ 整表作废（键里本来就带它，这里是顺手把旧层腾掉）。 */
  let cacheDocKey = null;

  /** 清空图片缓存（换根 / 磁盘变更由 `main.js` 调；⚠️ 不是"关掉缓存"）。 */
  function clearAssetCache() {
    ASSETS.clear();
    cacheDocKey = null;
  }

  /**
   * 把正文里的图片按上面那套规则处理掉，并**返回处理数量**（冒烟里要用）。
   *
   * ⭐ `design/0017` §2.3 ⑤ 增加的**可选**钩子 `hooks.onSettled()`：
   * 每张**本地**图都落定（`decode()` 完成 / `load` 或 `error` 到达）之后、
   * **再等两帧**（让布局定下来）调一次；没有本地图时也调一次。
   * ⚠️ 判据**不是** `readAsset` 的 Promise——IPC 回来只说明字节到了，
   * 解码与布局还没发生；拿那个时刻去校正滚动位置，`scrollHeight` 还是旧的。
   * ⚠️ 返回的 `stat` 形状**不变**（`window.__rmd.images` 照旧），⭐ 只多了 `cached` 一栏。
   *
   * ⭐ `hooks.docKey`（可选）：文档身份（`payload.real_path`）。**键必须带上它**——
   * 同一个 `src` 在两份文档里是两个文件（见 [`createAssetCache`] 边界 2）。
   *
   * @param {HTMLElement} docEl 正文容器
   * @param {{onChooseDirectory?: Function, onSettled?: Function, docKey?: string}} hooks
   */
  function renderImages(docEl, hooks) {
    const imgs = Array.prototype.slice.call(docEl.querySelectorAll('img'));
    const stat = { total: imgs.length, loaded: 0, cached: 0, unauthorized: 0, missing: 0, remote: 0, other: 0 };

    // ── 「落定」计数：本地图的每一张**恰好**结算一次 ──────────────────
    let pendingLocal = 0;
    let settledFired = false;
    function afterTwoFrames(fn) {
      if (typeof requestAnimationFrame !== 'function') { fn(); return; }
      requestAnimationFrame(function () { requestAnimationFrame(fn); });
    }
    function fireSettled() {
      if (settledFired) return;
      settledFired = true;
      if (hooks && typeof hooks.onSettled === 'function') {
        try { hooks.onSettled(); } catch (e) { console.error('onSettled 回调失败：', e); }
      }
    }
    function settleOne() {
      pendingLocal -= 1;
      if (pendingLocal > 0) return;
      afterTwoFrames(fireSettled);
    }
    /** 等**这一张真的进了布局**：有 `decode()` 就等它（失败也算落定）。 */
    function settleImage(img) {
      if (img && typeof img.decode === 'function') {
        img.decode().then(settleOne, settleOne);
        return;
      }
      if (!img || img.complete) { settleOne(); return; }
      img.addEventListener('load', settleOne, { once: true });
      img.addEventListener('error', settleOne, { once: true });
    }

    // ⭐ 文档身份：换文档 ⇒ 整表作废（键里本来就带它，这是顺手把旧层腾掉）。
    const docKey = hooks && typeof hooks.docKey === 'string' ? hooks.docKey : '';
    if (docKey !== cacheDocKey) {
      ASSETS.clear();
      cacheDocKey = docKey;
    }

    /**
     * 造出真正的那张 `<img>`。
     * ⚠️ **命中缓存与读盘回来走的是同一段**：`dataset.realPath` / `rmd-zoomable` /
     * `aria-label` / `zoomableSpecs` 全部照旧 ⇒ 缓存跳过的**只有读盘那一跳**（评审第 6 条）。
     * ⚠️ `inLink` 由调用方算好传进来（脱离文档的节点 `closest` 只查自己）。
     */
    function toReal(img, dataUrl, realPath, inLink) {
      const alt = img.getAttribute('alt') || '';
      const real = document.createElement('img');
      real.src = dataUrl;
      real.alt = alt;
      real.dataset.realPath = realPath;
      // ⭐ `design/0018`：**本地图**可进入缩放预览。⛔ 只在这里加——远程图与失败图不标记。
      real.classList.add('rmd-zoomable');
      real.draggable = false;
      if (!inLink) {
        // ⚠️ 链接里的图**不加** tabindex/role：`<a>` 自己就可聚焦，嵌套交互元素是坏结构。
        real.tabIndex = 0;
        real.setAttribute('role', 'button');
        // ⚠️ 这句挂在**图片元素**上：切语言时没人会重画它，所以由 `relabel()` 那一族
        //    之外的一条**轻量重贴**负责——登记在 `zoomableSpecs` 里（见下）。
        real.setAttribute('aria-label', t(alt ? 'img.view-with-alt' : 'img.view', { alt: alt }));
        zoomableSpecs.push({ el: real, alt: alt });
      }
      return real;
    }

    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      if (!src) continue;

      if (isRemote(src)) {
        // ⭐ V1 不自动加载。占位里给一个**用户自己点**的入口。
        const box = makePlaceholder(img,
          { key: 'img.remote', vars: { src: src } },
          { key: 'img.load-once', vars: {} });
        box._button.addEventListener('click', function () {
          const real = document.createElement('img');
          real.src = src;
          real.alt = img.getAttribute('alt') || '';
          box.replaceWith(real);
        });
        img.replaceWith(box);
        stat.remote += 1;
        continue;
      }

      // ⭐ 先看缓存（评审第 6 条）：命中就**不换占位、不闪烁、不发 IPC**。
      const cacheKey = docKey + '\u0000' + src;
      const hit = ASSETS.get(cacheKey);
      if (hit) {
        const inLinkHit = !!(img.closest && img.closest('a[href]'));
        const realHit = toReal(img, hit.url, hit.realPath, inLinkHit);
        img.replaceWith(realHit);
        stat.loaded += 1;
        stat.cached += 1;
        // ⚠️ 命中**也要**记一次落定：否则 `onSettled` 少了这一跳，
        //    阅读进度恢复会停在这一份文档上（大图文档尤其明显）。
        pendingLocal += 1;
        settleImage(realHit);
        continue;
      }

      // 先换成占位（"正在读"），免得渲染完到 IPC 回来之间出现破图
      const pending = makePlaceholder(img, { key: 'img.loading', vars: {} }, null);
      img.replaceWith(pending);
      const originalSrc = src;
      pendingLocal += 1;

      S.readAsset(originalSrc).then(function (asset) {
        // ⭐ `design/0018` §2.4：这张图能不能进缩放预览，只看**它是不是被链接包着**
        //    ——⚠️ 必须在 `replaceWith` **之前**算：脱离文档的节点 `closest` 只查自己。
        const inLink = !!(pending.closest && pending.closest('a[href]'));
        const real = toReal(img, asset.data_url, asset.real_path, inLink);
        // ⚠️ **先落缓存再换节点**：两件事的顺序无所谓，但缓存只认**成功**（边界 1）。
        ASSETS.put(cacheKey, asset.data_url, asset.real_path);
        pending.replaceWith(real);
        stat.loaded += 1;
        settleImage(real);
      }).catch(function (err) {
        const w = wordingFor(err, originalSrc);
        const box = makePlaceholder(img, w.spec,
          w.action === 'authorize' ? { key: 'img.authorize', vars: {} } : null);
        if (box._button) {
          box._button.addEventListener('click', function () {
            const done = hooks && hooks.onChooseDirectory ? hooks.onChooseDirectory() : null;
            if (done && done.then) done.then(function () { renderImages(docEl, hooks); });
          });
        }
        pending.replaceWith(box);
        if (err && err.kind === 'not_authorized') stat.unauthorized += 1;
        else if (err && err.kind === 'not_found') stat.missing += 1;
        else stat.other += 1;
        // ⚠️ 读失败也是"落定"：⛔ 不能让整个批次永久挂起。
        settleOne();
        // ⚠️ 这里**不打到状态条**：一份文档里二十张未授权的图会把状态条刷爆，
        //    而每张图自己已经说清楚了。`INV-FS-01` 的正确性不靠这条日志。
      });
    }
    // ⭐ 没有本地图（含整篇没图）⇒ 也要有一个"落定"信号。
    if (pendingLocal === 0) afterTwoFrames(fireSettled);
    return stat;
  }

  // ⭐ `createAssetCache` / `clearAssetCache` 也导出去：前者给 `tests/js` 用真实现钉边界，
  //    后者给 `main.js` 在换根 / 磁盘变更时腾内存（评审第 6 条）。
  const api = {
    renderImages,
    isRemote,
    wordingFor,
    relabel,
    createAssetCache: createAssetCache,
    clearAssetCache: clearAssetCache,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).imageView = api;
})();
