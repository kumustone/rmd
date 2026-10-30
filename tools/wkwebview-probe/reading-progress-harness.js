// rmd · 阅读进度恢复的**真 DOM 离屏探针**（跑 `design/0017` §7.4 的 12 条判据）
//
// ⭐ 跑的是**产品那几份**：
//    · `src/services/progress.js` —— 全部判据（`restorePlan` / `toAnchor` /
//      `shouldCorrect` / `toEntry`）；
//    · `src/services/reload.js` —— 锚点 → `scrollTop`（`resolveAnchor`，⛔ 不抄第二份）；
//    · `src/components/ImageView.js` —— `onSettled` 的落定语义（真 `decode()` ＋ 两帧 rAF）。
//    ⛔ 探针不抄第二份实现、不抄夹具（夹具是用 `canvas` 现生成的 `data:` PNG）。
//
// ⚠️ 唯一"照抄"的是 `src/main.js` 的那层**接线**（`restoreFor` / `applyRestore` /
//    `correctReadingProgress` / `markProgressUserAbort`）。`main.js` 是根脚本、进不了
//    这个页面，而 §7.4 要验的**正是这条接线** ⇒ 只能镜像。镜像时**只保留判据用得到的
//    那几行**：`lastAppliedByPath` 的写盘基线记账**不在这里**（§7.4 没有对应判据；
//    它在 `tests/js/progress.test.js` #18/#19 与 `design/0017` §7.3 里）。
//
// ⚠️ 离屏的安全形态（根 `CLAUDE.md` 工作约定 4）：
//    本文件只改**自己页面里的 DOM**、只在页面内 `dispatchEvent`（不可信事件，
//    ⛔ 不点亮任何系统级输入）。窗口本身由 `.swift` 那边 `alphaValue = 0` ＋ `orderBack` 建成。
//
// 约定：`window.__RUN()` 返回 `{环境, 夹具, 检查, 结论}`；判据在**退出码**上（`.sh` 聚合）。
(function () {
  'use strict';

  const P = window.rmd.progress;
  const R = window.rmd.reload;
  const IV = window.rmd.imageView;
  const doc = document.getElementById('doc');

  const RESTORE_EXPIRES_MS = 10000; // 与 main.js 的同名常量一致（10 s，§2.3 ⑤）

  // ── 镜像 main.js 的接线状态 ──────────────────────────────────────────
  let mountGen = 0;
  let pendingRestore = null;
  let currentPath = '';
  let mountDocSeq = 0;
  const writes = []; // 每次 `hostSetTop` 的落点（= 一次**可见的**位置写入）

  function headingPositions() {
    // 与 main.js 同形：宿主是元素时 = "离宿主内容区顶部的距离"。
    const base = doc.getBoundingClientRect().top - doc.scrollTop;
    const out = [];
    const els = doc.querySelectorAll('h2[id]');
    for (let i = 0; i < els.length; i++) {
      out.push({ id: els[i].id, top: els[i].getBoundingClientRect().top - base });
    }
    return out;
  }

  function scrollMetrics() {
    return { scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight };
  }

  function isScrollable() {
    const m = scrollMetrics();
    return m.scrollHeight - m.clientHeight > 1;
  }

  function hostSetTop(y) {
    writes.push(y);
    doc.scrollTop = y;
  }

  function currentDocSeq() {
    return mountDocSeq;
  }

  /** `main.js::restoreReadingProgress` 的镜像（入参换成"条目"而不是 payload）。 */
  function restoreFor(path, docSeq, entry) {
    const plan = P.restorePlan(entry, isScrollable());
    if (plan === 'skip') return plan;
    const base = {
      path: path,
      mountGen: mountGen,
      docSeq: docSeq,
      anchor: P.toAnchor(entry),
      appliedTop: 0,
      expires: Date.now() + RESTORE_EXPIRES_MS,
      userAborted: false,
    };
    if (plan === 'apply') applyRestore(base);
    else pendingRestore = base;
    return plan;
  }

  /** `main.js::applyRestore` 的镜像。 */
  function applyRestore(p) {
    const m = scrollMetrics();
    if (m.scrollHeight - m.clientHeight <= 1) {
      pendingRestore = p;
      return;
    }
    if (p.mountGen !== mountGen) return;
    const r = R.resolveAnchor(p.anchor, headingPositions(), m.scrollHeight, m.clientHeight);
    hostSetTop(r.scrollTop);
    pendingRestore = Object.assign({}, p, { appliedTop: r.scrollTop });
  }

  /** `main.js::correctReadingProgress` 的镜像（判据全在 `P.shouldCorrect`）。 */
  function correctReadingProgress(gen) {
    if (!pendingRestore || pendingRestore.mountGen !== gen) return;
    if (pendingRestore.userAborted) {
      pendingRestore = null;
      return;
    }
    if (!P.shouldCorrect(pendingRestore, gen, currentPath, currentDocSeq(), false, false, Date.now())) {
      if (Date.now() > pendingRestore.expires || pendingRestore.path !== currentPath) {
        pendingRestore = null;
      }
      return;
    }
    const p = pendingRestore;
    if (p.appliedTop === 0) {
      applyRestore(p);
      return;
    }
    const m = scrollMetrics();
    const r = R.resolveAnchor(p.anchor, headingPositions(), m.scrollHeight, m.clientHeight);
    pendingRestore = null;
    if (Math.abs(r.scrollTop - p.appliedTop) < 1) return; // 不到 1 px 不写
    hostSetTop(r.scrollTop);
  }

  /** `main.js::markProgressUserAbort` 的镜像。 */
  function markProgressUserAbort() {
    if (pendingRestore) pendingRestore.userAborted = true;
  }

  // ⚠️ 与 `main.js::setupReadingProgress` 同样的**输入事件**判据（⛔ 不看像素）。
  window.addEventListener('wheel', markProgressUserAbort, { passive: true });
  window.addEventListener('touchstart', markProgressUserAbort, { passive: true });
  window.addEventListener('pointerdown', markProgressUserAbort, { passive: true });
  window.addEventListener(
    'keydown',
    function (e) {
      if (!pendingRestore) return;
      const k = e.key;
      if (k === 'PageUp' || k === 'PageDown' || k === 'Home' || k === 'End' || k === ' ' ||
          k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
        pendingRestore.userAborted = true;
      }
    },
    true
  );

  // ── 夹具：`data:` 图片（canvas 现生成，⛔ 不读真实资产） ──────────────
  const ASSETS = Object.create(null);
  const deferred = [];

  /** ⚠️ ImageView 在**加载期**就把 `window.rmd.session` 取成了常量 ⇒ 这里补方法即可。 */
  window.rmd.session.readAsset = function (src) {
    const a = ASSETS[src];
    if (!a) return Promise.reject({ kind: 'not_found', message: 'probe 没登记 ' + src });
    if (a.defer) {
      return new Promise(function (resolve) {
        deferred.push({
          src: src,
          fire: function () {
            resolve({ data_url: a.url, real_path: '/probe/' + src });
          },
        });
      });
    }
    return Promise.resolve({ data_url: a.url, real_path: '/probe/' + src });
  };

  function release(src) {
    for (let i = deferred.length - 1; i >= 0; i--) {
      if (!src || deferred[i].src === src) {
        const d = deferred.splice(i, 1)[0];
        d.fire();
      }
    }
  }

  function makePng(w, h, color) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  }

  const sleep = function (ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  };

  async function waitUntil(fn, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (fn()) return true;
      await sleep(50);
    }
    return false;
  }

  // ── DOM 夹具 ────────────────────────────────────────────────────────
  function clearDoc() {
    doc.innerHTML = '';
    doc.scrollTop = 0;
  }

  function newMount(path, docSeq) {
    mountGen += 1;
    pendingRestore = null;
    currentPath = path;
    mountDocSeq = docSeq;
    clearDoc();
    return mountGen;
  }

  function addHeading(id, text) {
    const h = document.createElement('h2');
    h.id = id;
    h.textContent = text;
    doc.appendChild(h);
  }

  function addParagraphs(n, height) {
    for (let i = 0; i < n; i++) {
      const p = document.createElement('p');
      p.style.height = (height || 100) + 'px';
      p.textContent = '第 ' + (i + 1) + ' 段';
      doc.appendChild(p);
    }
  }

  function addImage(src) {
    const img = document.createElement('img');
    img.setAttribute('src', src);
    img.setAttribute('alt', '');
    doc.appendChild(img);
    return img;
  }

  function entryOf(id, offset, ratio) {
    return { id: id, offset: offset, ratio: ratio, source_bytes: 1, updated_at: 1 };
  }

  // ── 判据记录的公共形状 ─────────────────────────────────────────────
  const checks = [];
  function rec(id, name, ok, criterion, value) {
    checks.push({
      id: id,
      名: name,
      结果: ok === null ? '跳过' : (ok ? '通过' : '失败'),
      判据: criterion,
      值: value,
    });
  }

  /** 环境不成立（rAF 不来）⇒ 这类"要等落定"的判据只能记**跳过**，⛔ 不是失败。 */
  function needRaf() {
    return rafOK;
  }

  // ── 环境自证：rAF 来不来（`kb/0022`：可以用，但每次都要自证） ────────
  let rafOK = false;
  async function probeRaf() {
    let fired = 0;
    await new Promise(function (resolve) {
      let done = false;
      const t = setTimeout(function () {
        if (!done) { done = true; resolve(); }
      }, 1000);
      if (typeof requestAnimationFrame !== 'function') {
        clearTimeout(t);
        resolve();
        return;
      }
      requestAnimationFrame(function () {
        fired += 1;
        if (!done) { done = true; clearTimeout(t); resolve(); }
      });
    });
    return fired > 0;
  }

  // ── 判据 1：初始不可滚 + 有效条目 ⇒ defer，且 pendingRestore 非空 ────
  async function t1() {
    writes.length = 0;
    deferred.length = 0;
    newMount('/probe/short.md', 1);
    addHeading('h1', '标题');
    addParagraphs(2, 100); // 200 + 24 < 500（clientHeight）⇒ 不可滚
    const entry = entryOf('h1', 40, 0.3);
    const scrollable = isScrollable();
    const plan = P.restorePlan(entry, scrollable);
    restoreFor('/probe/short.md', 1, entry);
    const ok = scrollable === false && plan === 'defer' && pendingRestore !== null &&
               pendingRestore.anchor !== null && pendingRestore.anchor.id === 'h1' &&
               pendingRestore.mountGen === mountGen;
    return {
      ok: ok,
      criterion: "不可滚 ⇒ restorePlan='defer' ∧ pendingRestore 非空（意图没丢）",
      value: {
        可滚: scrollable,
        scrollHeight: scrollMetrics().scrollHeight,
        clientHeight: scrollMetrics().clientHeight,
        plan: plan,
        pending: pendingRestore && {
          path: pendingRestore.path,
          docSeq: pendingRestore.docSeq,
          mountGen: pendingRestore.mountGen,
          anchor: pendingRestore.anchor,
          appliedTop: pendingRestore.appliedTop,
        },
        写入次数: writes.length,
      },
    };
  }

  // ── 判据 2：插入大图，onSettled 后**确实发生一次**校正 ───────────────
  async function t2() {
    if (!needRaf()) return { ok: null, criterion: 'rAF 自证未过', value: { E1: false } };
    writes.length = 0;
    deferred.length = 0;
    ASSETS['big.png'] = { url: makePng(400, 800, '#88a') };

    const gen = newMount('/probe/tall.md', 2);
    addImage('big.png');
    addHeading('h1', '标题');
    addParagraphs(30, 100);

    const settled = { n: 0 };
    IV.renderImages(doc, {
      onSettled: function () {
        settled.n += 1;
        correctReadingProgress(gen);
      },
    });

    // 同步恢复：此时图还是占位（高 ~一行），目标 = 标题(≈24) + 200。
    const plan = restoreFor('/probe/tall.md', 2, entryOf('h1', 200, null));
    const applied = pendingRestore ? pendingRestore.appliedTop : -1;

    const arrived = await waitUntil(function () { return settled.n >= 1; }, 6000);
    if (!arrived) {
      return {
        ok: null,
        criterion: 'onSettled 6 s 内没到（离屏 rAF/解码环境不成立？）',
        value: { plan: plan, appliedTop: applied, onSettled次数: settled.n, 写入: writes.slice() },
      };
    }
    await sleep(100); // 让"两帧后再校正"那一支跑完
    const m = scrollMetrics();
    const expected = R.resolveAnchor(
      P.toAnchor(entryOf('h1', 200, null)), headingPositions(), m.scrollHeight, m.clientHeight
    ).scrollTop;
    const ok = settled.n === 1 && writes.length === 2 && Math.abs(writes[1] - applied) > 100 &&
               Math.abs(doc.scrollTop - expected) < 1 && Math.abs(writes[1] - expected) < 1 &&
               Math.abs(expected - applied) > 100;
    return {
      ok: ok,
      criterion: 'onSettled 恰好一次 ∧ 写两次（恢复 + 校正）∧ 最终落点 = 新布局下的锚点',
      value: {
        plan: plan,
        appliedTop: applied,
        校正后目标: expected,
        写入: writes.slice(),
        scrollTop: doc.scrollTop,
        onSettled次数: settled.n,
        图片自然高: (doc.querySelector('img') || {}).naturalHeight,
      },
    };
  }

  // ── 判据 3：IPC 早于解码（字节换入但 naturalHeight = 0 ⇒ onSettled 未触发） ──
  async function t3() {
    writes.length = 0;
    deferred.length = 0;
    ASSETS['slow.png'] = { defer: true, url: makePng(400, 800, '#7a7') };

    newMount('/probe/ipc.md', 3);
    addImage('slow.png');
    addParagraphs(5, 100);

    const settled = { n: 0 };
    IV.renderImages(doc, { onSettled: function () { settled.n += 1; } });

    release('slow.png');
    // ⚠️ 只等**微任务**（⛔ 不是一个 task）：IPC 的 `.then` 跑在这里，
    //    而解码/布局**至少**要跨一个 task ⇒ 这一刻正是"字节到了、还没解码"。
    await Promise.resolve();
    await Promise.resolve();

    const real = doc.querySelector('img');
    const atIpc = {
      有真图: real !== null,
      是_data_url: real ? /^data:image\//.test(real.getAttribute('src') || '') : false,
      naturalHeight: real ? real.naturalHeight : -1,
      onSettled次数: settled.n,
    };

    if (!needRaf()) {
      return { ok: null, criterion: 'rAF 自证未过', value: { IPC时刻: atIpc } };
    }
    const arrived = await waitUntil(function () { return settled.n >= 1; }, 6000);
    const after = { naturalHeight: real ? real.naturalHeight : -1, onSettled次数: settled.n };
    const ok = atIpc.有真图 && atIpc.是_data_url && atIpc.naturalHeight === 0 &&
               atIpc.onSettled次数 === 0 && arrived && after.naturalHeight > 0 &&
               after.onSettled次数 === 1;
    return {
      ok: ok,
      criterion: 'IPC 后（同一微任务检查点）字节已换入 ∧ naturalHeight=0 ∧ onSettled 未触发；load 之后才触发一次',
      value: { IPC时刻: atIpc, 落定后: after },
    };
  }

  // ── 判据 4：坏图 ⇒ onSettled 仍触发一次，⛔ 不永久挂起 ──────────────
  // ⚠️ 两个**不同的**失败面都要有出口（R3 的原话是"坏图与'没有待定图'各有明确出口"）：
  //    ① 字节读回来了但**解码失败**（走 `decode()` 的 reject 支）；
  //    ② 字节**根本没读到**（`readAsset` reject ⇒ ImageView 的 `.catch` 支）。
  //    只测 ① 的话，`.catch` 里那句 `settleOne()` 删掉也**一条都不会红**（实测过）。
  async function t4() {
    if (!needRaf()) return { ok: null, criterion: 'rAF 自证未过', value: {} };
    const out = {};

    // ① 坏字节：readAsset 成功，decode 失败
    writes.length = 0;
    deferred.length = 0;
    ASSETS['bad.png'] = { url: 'data:image/png;base64,AAAA' };
    newMount('/probe/bad.md', 4);
    addImage('bad.png');
    addParagraphs(3, 100);
    const s1 = { n: 0 };
    IV.renderImages(doc, { onSettled: function () { s1.n += 1; } });
    const arrived1 = await waitUntil(function () { return s1.n >= 1; }, 6000);
    out['解码失败'] = { onSettled次数: s1.n, 到没到: arrived1 };

    // ② 读不到字节：readAsset reject（不登记的 src ⇒ not_found）
    writes.length = 0;
    deferred.length = 0;
    newMount('/probe/missing.md', 5);
    addImage('missing.png');
    addParagraphs(3, 100);
    const s2 = { n: 0 };
    IV.renderImages(doc, { onSettled: function () { s2.n += 1; } });
    const arrived2 = await waitUntil(function () { return s2.n >= 1; }, 6000);
    out['读取失败'] = { onSettled次数: s2.n, 到没到: arrived2 };

    return {
      ok: arrived1 && s1.n === 1 && arrived2 && s2.n === 1,
      criterion: '坏字节（decode 失败）与读取失败（readAsset reject）都恰好落定一次',
      value: out,
    };
  }

  // ── 判据 5：没有本地图片 ⇒ 空批次也要有"落定"信号 ────────────────────
  async function t5() {
    if (!needRaf()) return { ok: null, criterion: 'rAF 自证未过', value: {} };
    writes.length = 0;
    deferred.length = 0;
    newMount('/probe/noimg.md', 5);
    addHeading('h1', '没有图的文档');
    addParagraphs(3, 100);

    const settled = { n: 0 };
    IV.renderImages(doc, { onSettled: function () { settled.n += 1; } });
    const arrived = await waitUntil(function () { return settled.n >= 1; }, 6000);
    return {
      ok: arrived && settled.n === 1,
      criterion: '没有本地图时 onSettled 仍触发一次',
      value: { onSettled次数: settled.n, 到没到: arrived },
    };
  }

  // ── 判据 6：旧挂载的迟到回调 ⛔ 不许消耗新挂载的 pendingRestore ───────
  async function t6() {
    if (!needRaf()) return { ok: null, criterion: 'rAF 自证未过', value: {} };
    writes.length = 0;
    deferred.length = 0;
    ASSETS['late.png'] = { defer: true, url: makePng(300, 600, '#a88') };

    // 挂载 A（有图，尚未落定）
    const genA = newMount('/probe/a-old.md', 6);
    addImage('late.png');
    const settledA = { n: 0 };
    IV.renderImages(doc, {
      onSettled: function () {
        settledA.n += 1;
        correctReadingProgress(genA);
      },
    });

    // 换成挂载 B（**可滚** + 有效条目 ⇒ apply：B 的 pendingRestore 非空、appliedTop > 0）
    // ⚠️ 这里必须用 apply 而不是 defer：defer 的 pending 在 `applyRestore` 里还有一道
    //    "不可滚"早退挡着，于是**删掉挂载代号闸也看不出来**（实测：那样变异红了 0 条）。
    //    apply 之后"旧回调有没有把它消耗掉"唯一可观察的形态就是 `pendingRestore` 变 null。
    const genB = newMount('/probe/b-new.md', 7);
    addHeading('h1', 'B 的标题');
    addParagraphs(20, 100);
    const plan = restoreFor('/probe/b-new.md', 7, entryOf('h1', 100, 0.5));
    const before = pendingRestore;
    const writesAfterRestore = writes.length;

    // A 的字节现在才回来 ⇒ A 的 onSettled 迟到
    release('late.png');
    const arrived = await waitUntil(function () { return settledA.n >= 1; }, 6000);
    await sleep(150); // 再给两帧 + 校正一次

    const ok = arrived && before !== null && plan === 'apply' && pendingRestore === before &&
               writes.length === writesAfterRestore && pendingRestore.mountGen === genB && genA !== genB;
    return {
      ok: ok,
      criterion: '旧挂载回调到达后：B 的 pendingRestore 原样存活 ∧ 零次新的位置写入',
      value: {
        plan: plan,
        genA: genA,
        genB: genB,
        onSettledA次数: settledA.n,
        pending还在: pendingRestore === before,
        pending_mountGen: pendingRestore ? pendingRestore.mountGen : null,
        恢复时的写入: writesAfterRestore,
        总写入: writes.length,
      },
    };
  }

  // ── 判据 7：同路径二次挂载（mountGen 不同）⇒ 旧回调同样作废 ──────────
  async function t7() {
    if (!needRaf()) return { ok: null, criterion: 'rAF 自证未过', value: {} };
    writes.length = 0;
    deferred.length = 0;
    ASSETS['late2.png'] = { defer: true, url: makePng(300, 600, '#8a8') };

    const genA = newMount('/probe/same.md', 8);
    addImage('late2.png');
    const settledA = { n: 0 };
    IV.renderImages(doc, {
      onSettled: function () {
        settledA.n += 1;
        correctReadingProgress(genA);
      },
    });

    // ⭐ 同**路径**、同**会话号**——只有挂载代号能分辨这两次挂载
    // ⚠️ 同判据 6：B 必须是 **apply**（defer 会被 applyRestore 的"不可滚"早退挡掉，
    //    那样删掉挂载代号闸也红不了）。
    const genB = newMount('/probe/same.md', 8);
    addHeading('h1', 'B 的标题');
    addParagraphs(20, 100);
    const plan = restoreFor('/probe/same.md', 8, entryOf('h1', 100, 0.5));
    const before = pendingRestore;
    const writesAfterRestore = writes.length;

    release('late2.png');
    const arrived = await waitUntil(function () { return settledA.n >= 1; }, 6000);
    await sleep(150);

    const ok = arrived && genA !== genB && before !== null && plan === 'apply' &&
               pendingRestore === before && writes.length === writesAfterRestore;
    return {
      ok: ok,
      criterion: '同路径同 docSeq 的两次挂载：mountGen 必须不同，旧回调不得消耗新 pending',
      value: {
        genA: genA,
        genB: genB,
        plan: plan,
        onSettledA次数: settledA.n,
        pending还在: pendingRestore === before,
        恢复时的写入: writesAfterRestore,
        总写入: writes.length,
      },
    };
  }

  /** 装一个"可滚 + 已 apply"的 pending（三种接管事件各用一个）。 */
  function armAppliedPending(path, docSeq) {
    writes.length = 0;
    deferred.length = 0;
    const gen = newMount(path, docSeq);
    addHeading('h1', '标题');
    addParagraphs(20, 100);
    const plan = restoreFor(path, docSeq, entryOf('h1', 100, 0.5));
    return { gen: gen, plan: plan, appliedTop: pendingRestore ? pendingRestore.appliedTop : -1 };
  }

  // ── 判据 8：用户接管（wheel / pointerdown / PageDown） ────────────────
  async function t8() {
    const cases = [];
    const evs = [
      ['wheel', function () { window.dispatchEvent(new Event('wheel')); }],
      ['pointerdown', function () {
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      }],
      ['PageDown', function () {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
      }],
    ];
    for (let i = 0; i < evs.length; i++) {
      const label = evs[i][0];
      const armed = armAppliedPending('/probe/take-' + label + '.md', 9 + i);
      const before = writes.length;
      const hadPending = pendingRestore !== null;
      evs[i][1]();
      const aborted = pendingRestore ? pendingRestore.userAborted === true : false;
      correctReadingProgress(armed.gen); // 作废 ⇒ 不许写
      cases.push({
        事件: label,
        plan: armed.plan,
        hadPending: hadPending,
        userAborted: aborted,
        校正后写入增量: writes.length - before,
        pending被清: pendingRestore === null,
      });
    }
    const ok = cases.every(function (c) {
      return c.plan === 'apply' && c.hadPending && c.userAborted &&
             c.校正后写入增量 === 0 && c.pending被清;
    });
    return {
      ok: ok,
      criterion: 'wheel / pointerdown / PageDown 任一 ⇒ userAborted=true ∧ 后续零次位置写入',
      value: cases,
    };
  }

  // ── 判据 9：程序滚动不产生接管（不误判） ────────────────────────────
  async function t9() {
    const armed = armAppliedPending('/probe/prog.md', 12);
    await sleep(200); // 让程序滚动产生的 scroll 事件（如果有）先到达
    const ok = armed.plan === 'apply' && armed.appliedTop > 0 && pendingRestore !== null &&
               pendingRestore.userAborted === false && doc.scrollTop > 0;
    return {
      ok: ok,
      criterion: 'hostSetTop 的程序滚动不把 userAborted 置真',
      value: {
        plan: armed.plan,
        appliedTop: armed.appliedTop,
        scrollTop: doc.scrollTop,
        pending还在: pendingRestore !== null,
        userAborted: pendingRestore ? pendingRestore.userAborted : null,
      },
    };
  }

  // ── 判据 10：目标与 appliedTop 差 < 1 px ⇒ 不写第二次 ────────────────
  async function t10() {
    const armed = armAppliedPending('/probe/nudge.md', 13);
    const before = writes.length;
    const first = pendingRestore ? pendingRestore.appliedTop : -1;
    correctReadingProgress(armed.gen);
    const afterFirst = { 写入增量: writes.length - before, pending被清: pendingRestore === null };
    correctReadingProgress(armed.gen); // 再来一次（此时已经没有 pending）
    const afterSecond = { 写入增量: writes.length - before };
    const ok = armed.plan === 'apply' && first === armed.appliedTop &&
               afterFirst.写入增量 === 0 && afterFirst.pending被清 && afterSecond.写入增量 === 0;
    return {
      ok: ok,
      criterion: '校正目标与 appliedTop 差 < 1 px ⇒ 一次都不写（第二次也不写）',
      value: { plan: armed.plan, appliedTop: first, 第一次校正: afterFirst, 第二次校正: afterSecond },
    };
  }

  // ── 判据 11：10 s 过期 ⇒ 回调到达也不再校正 ─────────────────────────
  async function t11() {
    writes.length = 0;
    deferred.length = 0;
    const gen = newMount('/probe/expired.md', 14);
    addHeading('h1', '标题');
    addParagraphs(20, 100);
    const before = writes.length;
    pendingRestore = {
      path: '/probe/expired.md',
      mountGen: gen,
      docSeq: 14,
      anchor: { id: 'h1', offset: 100, ratio: 0.5 },
      appliedTop: 50,
      expires: Date.now() - 1,
      userAborted: false,
    };
    correctReadingProgress(gen);
    const ok = writes.length === before && pendingRestore === null;
    return {
      ok: ok,
      criterion: '过期（expires < now）⇒ P.shouldCorrect 假 ∧ 不写 ∧ pending 被清',
      value: { 写入增量: writes.length - before, pending被清: pendingRestore === null },
    };
  }

  // ── 总装 ────────────────────────────────────────────────────────────
  window.__RUN = async function () {
    const t0 = Date.now();
    const errors = [];

    // ⚠️ 产品模块必须在场（缺了就是页面装配错了，⛔ 不是判据失败）。
    if (!P || !R || !IV) {
      return {
        致命: '产品模块没加载齐：progress=' + !!P + ' reload=' + !!R + ' imageView=' + !!IV,
      };
    }
    if (typeof window.rmd.session.readAsset !== 'function') {
      return { 致命: 'window.rmd.session.readAsset 没装上（ImageView 取不到 S？）' };
    }

    rafOK = await probeRaf();

    const tests = [
      [1, '初始不可滚 + 有效条目 ⇒ defer', t1],
      [2, '大图落定后真的校正一次', t2],
      [3, 'IPC 早于解码', t3],
      [4, '坏图也落定一次', t4],
      [5, '没有本地图也落定一次', t5],
      [6, '旧挂载的迟到回调不消耗新 pending', t6],
      [7, '同路径二次挂载，旧回调作废', t7],
      [8, '用户接管（wheel / pointerdown / PageDown）', t8],
      [9, '程序滚动不误判为接管', t9],
      [10, '差异 < 1 px 不写第二次', t10],
      [11, '10 s 过期不再校正', t11],
    ];

    for (const [id, name, fn] of tests) {
      try {
        const r = await fn();
        rec(id, name, r.ok, r.criterion, r.value);
      } catch (e) {
        errors.push({ id: id, error: String((e && e.stack) || e) });
        rec(id, name, false, '抛错', String((e && e.message) || e));
      }
    }

    const 通过 = checks.filter(function (c) { return c.结果 === '通过'; }).length;
    const 失败 = checks.filter(function (c) { return c.结果 === '失败'; }).length;
    const 跳过 = checks.filter(function (c) { return c.结果 === '跳过'; }).length;

    return {
      环境: {
        'E1_rAF': rafOK,
        视口: { clientHeight: doc.clientHeight, scrollHeight: doc.scrollHeight },
        墙钟秒: Math.round((Date.now() - t0) / 10) / 100,
        '⚠️ 判据 12': '「前台被抢过没有」由 .swift 侧起跑前后比 frontmostApplication，聚合器记作判据 12',
        错误: errors,
      },
      夹具: {
        正文容器: '#doc（height: 500px; overflow-y: auto）',
        图片: 'canvas 现生成的 data: PNG（⛔ 不读真实资产）',
        尺寸: '大图 400×800（天然高 800，解码前 naturalHeight=0）',
        '⚠️ 接线镜像': 'main.js 的 restore/apply/correct/markAbort（只留判据用得到的行；' +
                     'lastAppliedByPath 的写盘记账不在这里）',
      },
      检查: checks,
      结论: { 通过: 通过, 失败: 失败, 跳过: 跳过 },
    };
  };

  window.__READY = true;
})();
