// 文档内链接导航的**页面侧**（`design/0026` §7.2 的判据 1–5 先把原始观测摆出来，
// 判定在 `link-nav-probe.sh` 的聚合器里做——它手上还有 Swift 记的**导航日志**）。
//
// # 它跑的是谁
//
// | 这一份 | 来源 |
// |---|---|
// | `href` 归一 / 结果→动作 / 存活判据 | ⭐ **产品那份** `src/services/links.js`（原样拷进页面） |
// | `K.hasModifier` | ⭐ **产品那份** `src/services/keymap.js` |
// | 委托注册、`followLink` 的流程 | ⚠️ **镜像**自 `src/main.js`（根脚本进不了探针页） |
// | 后端 `open_link` | 假货：按 `href` 给一份固定的 `LinkOutcome`（⛔ 只有"后端会回什么"是假的） |
//
// ⚠️⚠️ **镜像的那一层，产品侧由 `tests/js/links.test.js` 的源码级闸门守**（#19–#24：
//    注册次序在 `ImageViewer.installDelegation` 之后、只读 `getAttribute('href')`、
//    `defaultPrevented` 是第一句、带回 `doc_seq` 并先判存活、滚动只经 `hostSetTop`）。
//    探针**不能**证明"`main.js` 接对了"——它能证明的是"这套形状在真 WKWebView 里
//    遇到真点击时发生什么"，以及 WebKit 自己那几条事实（同文档锚点走不走导航回调）。
//
// ⚠️⚠️ **不可信事件的边界**（`design/0014` 的 `vim-keys-probe` 同族）：
//    页面里的 `el.click()` 是**不可信事件**，WebKit **不为它执行默认导航**
//    ⇒ "点了但 location 没变"本身**证明不了** `preventDefault` 起了作用。
//    所以判据 2（对照组）用的是**程序性导航** `location.href = 'other.md'`——
//    那是 WebKit 真的会走 `decidePolicyFor` 的一条路（= Tauri `on_navigation` 的等价物）。
//
// # 时间戳
//
// 每一步都记 `t0/t1`（`Date.now()`，毫秒）。Swift 那边也用同一只墙钟记每条导航
// ⇒ 聚合器按窗口把导航归到步骤上。⚠️ 步内等 180 ms，窗口足够宽、也不会把相邻步吞进来。

'use strict';

(function () {
  const L = window.rmd.links;
  const K = window.rmd.keymap;

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  function $(id) { return document.getElementById(id); }

  // ── 假后端：`open_link` 会回什么（`commands/link.rs::LinkOutcome` 的形状）──
  const 回包 = {
    'other.md#sec': { kind: 'document', path: '/tmp/other.md', fragment: 'sec' },
    '#sec-1': { kind: 'anchor', fragment: 'sec-1' },
    'rmd-unsupported:javascript': { kind: 'unsupported', message: 'javascript' },
    'javascript:window.__PWNED=1': { kind: 'unsupported', message: 'javascript' },
  };

  // ── 观察面 ──
  const followCalls = [];
  const 计划 = [];
  const 观察 = { 点击后_defaultPrevented: null, ALIVE: false };

  /** ⚠️ **镜像** `main.js::followLink`（后端换成假货、其余形状逐字照抄）。 */
  async function follow(href) {
    const raw = L.normalizeHref(href);
    const seq = 1;
    followCalls.push(raw);
    let out;
    try {
      out = 回包[raw] || { kind: 'failed', message: 'probe: 没有这一格' };
    } catch (e) {
      计划.push({ href: raw, action: 'throw', message: String(e) });
      return;
    }
    if (!L.isAlive(seq, 1)) return;
    const p = L.plan(out);
    计划.push({
      href: raw,
      action: p.action,
      key: p.key || '',
      fragment: p.fragment || '',
      path: p.path || '',
      错误: p.isError === true,
    });
  }

  /** ⚠️ **镜像** `main.js::installLinkDelegation`（结构逐字；注释见那边的文件头）。 */
  function installDelegation(docEl) {
    function linkOf(target) {
      if (!target || typeof target.closest !== 'function') return null;
      return target.closest('a[href]');
    }
    function owns(e) { return !K.hasModifier(e); }

    function onClick(e) {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      const a = linkOf(e.target);
      if (!a) return;
      if (!owns(e)) return;
      e.preventDefault();
      follow(a.getAttribute('href'));
    }
    function onKeydown(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.isComposing || e.keyCode === 229) return;
      if (e.defaultPrevented) return;
      const a = linkOf(e.target);
      if (!a) return;
      if (!owns(e)) return;
      e.preventDefault();
      follow(a.getAttribute('href'));
    }

    docEl.addEventListener('click', onClick);
    docEl.addEventListener('keydown', onKeydown);
    // ⭐ **后注册的**监听器：同一节点上它在本委托之后跑 ⇒ 读到的 `defaultPrevented`
    //    就是"我们那一层拦没拦"的**直接证据**（`stopPropagation` 拦不住同节点监听器）。
    docEl.addEventListener('click', function (e) {
      观察.点击后_defaultPrevented = e.defaultPrevented;
    });
  }

  const 步骤 = [];

  async function step(id, 说明, fn) {
    const t0 = Date.now();
    const loc0 = location.href;
    const f0 = followCalls.length;
    const p0 = 计划.length;
    let extra = {};
    try {
      extra = (await fn()) || {};
    } catch (e) {
      extra = { 抛错: String(e) };
    }
    await wait(180);
    步骤.push(Object.assign({
      id: id,
      说明: 说明,
      t0: t0,
      t1: Date.now(),
      location_之前: loc0,
      location_之后: location.href,
      followLink_收到: followCalls.slice(f0),
      计划: 计划.slice(p0),
    }, extra));
  }

  window.__RUN = async function () {
    if (!L || !K) {
      return { 致命: 'window.rmd.links / window.rmd.keymap 不在（加载顺序或加载期错误）' };
    }
    installDelegation($('doc'));

    // 1 · 点击相对链接（处理器 preventDefault）
    await step('s1', '点击相对链接（处理器 preventDefault）', async function () {
      观察.点击后_defaultPrevented = null;
      $('rel').click();
      await wait(30);
      return { 点击后_defaultPrevented: 观察.点击后_defaultPrevented };
    });

    // 2 · 对照组：程序性导航（不可信 click 不会导航 ⇒ 用这条路证"闸门回调活着"）
    await step('s2', '对照组：程序性导航到 other.md（闸门回调必须收到）', async function () {
      location.href = 'other.md';
      await wait(80);
    });

    // 3 · 同文档锚点：点击时被拦（判据 3 的正面）
    await step('s3', '点击同文档锚点 #sec-1（处理器 preventDefault）', async function () {
      观察.点击后_defaultPrevented = null;
      $('frag').click();
      await wait(30);
      return { 点击后_defaultPrevented: 观察.点击后_defaultPrevented };
    });

    // 3b · **事实记录**：同文档锚点导航到底走不走 `decidePolicyFor`（`design/0026` §7.1 0a）
    //      ⚠️ 两种答案都正常 ⇒ 这一条只要求"答得出来"，判定在聚合器里。
    await step('s3b', '事实：程序性 location.hash（同文档锚点走不走导航回调）', async function () {
      location.hash = '#sec-1';
      await wait(80);
    });

    // 4 · 闸门拒绝之后：地址没变、页面还活着（能继续跑就是结构证明）
    await step('s4', '闸门拒绝后地址不变、页面存活', async function () {
      location.href = 'other.md';
      await wait(80);
      window.__ALIVE = true;
      观察.ALIVE = window.__ALIVE === true;
    });

    // 5 · `rmd-unsupported:javascript`：点击后不导航、也没有脚本执行
    await step('s5', '点击 rmd-unsupported:javascript（不导航、无脚本执行）', async function () {
      $('jsmark').click();
      await wait(30);
      // 反面对照：真 `javascript:` 也不能借这条路执行（即便默认行为真的发生）
      $('rawjs').click();
      await wait(30);
      return { PWNED: typeof window.__PWNED === 'undefined' ? null : String(window.__PWNED) };
    });

    return {
      环境: {
        标题: document.title,
        链接数: document.querySelectorAll('#doc a[href]').length,
        锚点存在: !!$('sec-1'),
        加载期错误: window.__LOADERR || [],
      },
      夹具: {
        页面: '手搭的最小正文（4 条链接 ＋ 1 个锚点）',
        后端: '假 open_link：按 href 给固定 LinkOutcome（⛔ 只有"后端会回什么"是假的）',
        产品代码: 'src/services/links.js ＋ src/services/keymap.js（原样拷入）',
        镜像: 'installLinkDelegation / followLink 的结构镜像自 src/main.js（根脚本进不了探针页）',
      },
      观察: 观察,
      步骤: 步骤,
    };
  };
})();
