// rmd · 「文档列表」的**离屏接线闸门**（`design/0041` §7）
//
// ⭐ 2026-10-24 改写：从"取证探针"升级成**闸门**——`components/DocList.js` 落地之后，
//    本 harness 一律跑**产品那五份**（`services/{i18n,versions,chunked,doclists,session}.js`
//    ＋ `components/DocList.js`），行结构与 CSS 也来自产品
//    （`styles/{tokens,themes,typography,sidebar}.css`）。
//    ⇒ 数字不再只对"拟定形状"成立；判据进**退出码**。
//
// # 它回答两件事
//
// ① **成本**：500 / 1 276 / 2 000 / 5 000 行，从 `refresh()` 到「首批 DOM＋布局完成」
//    与「全部完成」各多久。⚠️ 口径 = **DOM 建完 ＋ 布局完成**，⛔ 不含上屏（paint）；
//    ⛔ 不含真 IPC（假后端）与文件读取。
// ② **正确性（评审给的那三条反例，落到真 DOM 上）**：
//    A 正常量级下一行不少；B 超 `MAX_RENDER` 时**停在 5000 且有一句常驻说明**；
//    C 点一行发的是那一行的 `real_path`；
//    ⭐ D **刷新在途时旧分片必须回滚清空**（`INV-DOCS-09`，评审的"残留 500 行"）。
//
// # ⚠️ 三条口径（引用这些数字时必须一起说）
//
// 1. **墙钟**：`performance.now()`，单进程内。假后端 ⇒ ⛔ 不含真 IPC。
// 2. **布局是强制的**：每次记时点后读 `scrollHeight` ＋ `getBoundingClientRect()`
//    （否则 WebKit 把布局摊到下一帧，"插入很快"是假象）。
// 3. ⛔ **内存没有量**：WKWebView 没有可靠的 JS 堆读数 ⇒ 本探针不给内存数字。

(function () {
  'use strict';

  const N_LIST = [500, 1276, 2000, 5000];
  const ROUNDS = 3;
  const CONTAINER_W = 280; // 侧边栏默认宽度（`design/0003`）
  const CONTAINER_H = 760;
  /** 全部完成的上限等待（自造超时：探针⛔ 不许无限挂住）。 */
  const WAIT_MS = 30000;

  const DL = window.rmd.doclists;
  const MAX_RENDER = DL.MAX_RENDER;
  const ROOT = '/Users/probe/workspace';

  // ── 假后端（只实现本页用到的两条命令）──────────────────────────────────

  const backend = {
    entries: [],
    /** 挂住下一次 `list_documents` 的回包（用例用来制造"刷新在途"的窗口）。 */
    holds: [],
    calls: 0,
    setEntries: function (n) { backend.entries = mkEntries(n); },
  };

  /** 造 `n` 条条目（名字与路径都唯一；形状与后端 `IndexEntry` 一致）。 */
  function mkEntries(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const name = '0' + (i % 40) + '-文档列表与空目录过滤-产品对照-' + i + '.md';
      const parent = 'repo-' + (i % 37) + '/docs/research/notes';
      out.push({
        root: ROOT,
        real_path: ROOT + '/' + parent + '/' + name,
        rel: parent + '/' + name,
        name: name,
      });
    }
    return out;
  }

  function snapshot() {
    return {
      generation: 1,
      mode: 'directory',
      roots: [ROOT],
      files: [],
      pending_directory: null,
      sidebar_width: CONTAINER_W,
      last_directory: ROOT,
      reading_progress: {},
      dir_session: null,
      doc_seq: 1,
      sidebar_file_view: 'list',
      hide_empty_dirs: true,
    };
  }

  function installBackend() {
    window.__TAURI__ = window.__TAURI__ || {};
    window.__TAURI__.core = {
      invoke: function (cmd, args) {
        if (cmd === 'get_session') return Promise.resolve(snapshot());
        if (cmd === 'list_documents') {
          backend.calls += 1;
          const payload = {
            gen: args.generation,
            req: args.req,
            index_rev: backend.calls,
            age_ms: 0,
            complete: true,
            incomplete: [],
            incomplete_truncated: false,
            roots: [ROOT],
            entries: backend.entries.slice(),
            keep_dirs: [],
            total: backend.entries.length,
            truncated: false,
            max_docs: 10000,
            stats: {},
          };
          const hold = backend.holds.shift();
          if (hold) return hold.promise.then(function () { return payload; });
          return Promise.resolve(payload);
        }
        throw new Error('未预料的命令：' + cmd);
      },
    };
  }

  // ── 小工具 ───────────────────────────────────────────────────────────

  function forceLayout(el) {
    void el.scrollHeight;
    void el.getBoundingClientRect().height;
  }

  function median(xs) {
    const a = xs.slice().sort(function (x, y) { return x - y; });
    return a[Math.floor(a.length / 2)];
  }

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function deferred() {
    let resolve;
    const promise = new Promise(function (res) { resolve = res; });
    return { promise: promise, resolve: resolve };
  }

  function newHost() {
    const old = document.getElementById('doclist-probe-host');
    if (old) old.remove();
    const host = document.createElement('div');
    host.id = 'doclist-probe-host';
    host.style.cssText = 'width:' + CONTAINER_W + 'px;height:' + CONTAINER_H +
      'px;overflow:auto;position:relative;';
    document.body.appendChild(host);
    return host;
  }

  function rowsOf(host) { return host.querySelectorAll('.doclist-row').length; }
  function notesOf(host) { return host.querySelectorAll('.doclist-note').length; }

  /** 点一行（产品绑的是 `click`；这里发一个真事件，⛔ 不直接调内部函数）。 */
  function clickRow(row) {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // ── ① 成本测量 ───────────────────────────────────────────────────────

  /**
   * 跑一轮：建 DocList → 挂上 → `refresh()` → 等全部画完。
   * @returns {Promise<{首批可见:number, 全部完成:number, 行数:number, 说明行数:number,
   *                    首行标题:string, 点击回传:string|string, 超时?:boolean}>}
   */
  function runOnce(n) {
    backend.setEntries(n);
    const host = newHost();
    const opened = [];
    const dl = window.rmd.docList.createDocList({
      host: host,
      onOpenFile: function (p) { opened.push(p); },
      // ⚠️ `INV-SET-01`：这块**不是** `src/**`，但同样⛔ 不写字面键位——
      //    本探针不验文案，给空串即可（截断那句会走 `doclist.truncated-nokey`）。
      keyText: function () { return ''; },
    });
    dl.setActive(true);

    const shown = Math.min(n, MAX_RENDER);
    const t0 = performance.now();

    return new Promise(function (resolve) {
      let tFirst = -1;
      let settled = false;
      let timer = null;
      const obs = new MutationObserver(function () {
        const rows = rowsOf(host);
        if (tFirst < 0 && rows > 0) {
          forceLayout(host);
          tFirst = performance.now() - t0;
        }
        // ⚠️ 说明行是 `onDone` 里补的，与最后一批**同一个任务** ⇒ 到这里它已经在 DOM 里了。
        if (rows >= shown) done(false);
      });
      function done(timedOut) {
        if (settled) return;
        settled = true;
        obs.disconnect();
        if (timer !== null) clearTimeout(timer);
        if (!timedOut) forceLayout(host);
        const first = host.querySelector('.doclist-row');
        if (first) clickRow(first);
        const out = {
          首批可见: tFirst < 0 ? -1 : +tFirst.toFixed(2),
          全部完成: timedOut ? -1 : +(performance.now() - t0).toFixed(2),
          行数: rowsOf(host),
          说明行数: notesOf(host),
          首行标题: first ? first.title : '',
          点击回传: opened.length ? opened[0] : '',
        };
        if (timedOut) out.超时 = true;
        dl.destroy();
        resolve(out);
      }
      timer = setTimeout(function () { done(true); }, WAIT_MS);
      obs.observe(host, { childList: true, subtree: true });
      // ⚠️ 回包是异步的（假后端也是 Promise）⇒ 观察器必须先挂上再 `refresh()`。
      dl.refresh().catch(function (e) { console.error('refresh 失败：', e); });
    });
  }

  // ── ② 三条正确性判据（跑产品代码，落到真 DOM）──────────────────────────

  /** 判据 B：超 `MAX_RENDER` ⇒ 停在 5000，且**常驻一句说明**（`INV-DOCS-04`）。 */
  async function checkTruncation() {
    const n = MAX_RENDER + 5;
    const r = await runOnce(n);
    const host = document.getElementById('doclist-probe-host');
    const noteText = Array.prototype.map.call(
      host ? host.querySelectorAll('.doclist-note') : [],
      function (el) { return el.textContent || ''; }
    ).join(' ');
    const ok = r.行数 === MAX_RENDER && r.说明行数 >= 1
      && noteText.indexOf(String(MAX_RENDER)) >= 0;
    return {
      判据: 'B 超上限停在 ' + MAX_RENDER + ' 且说明可见',
      输入行数: n,
      画出行数: r.行数,
      说明行数: r.说明行数,
      ok: ok,
    };
  }

  /** 判据 C：点一行发的是那一行的 `real_path`（⛔ 不是拼出来的路径）。 */
  function checkRowClick(n, round) {
    const expect = backend.entries[0] ? backend.entries[0].real_path : '';
    const ok = round.点击回传 === expect && round.首行标题 === expect && expect !== '';
    return {
      判据: 'C 点一行回传 real_path',
      期望: expect,
      实测: round.点击回传,
      悬停: round.首行标题,
      ok: ok,
    };
  }

  /**
   * ⭐ 判据 D：**刷新在途**时旧分片必须回滚并停下（`INV-DOCS-09`）。
   *
   * 这是评审给的那个反例的机制：同根刷新**不改授权代次**，旧的 5 000 行任务
   * 只画了首片 500 行，剩下的排进了定时器。此时新请求在路上——
   * 唯一能拦住旧分片的是"每个分片开头现取组合令牌"（`chunked.js` 的 `currentGen`）。
   * ⇒ 断言：那一刻容器里的行数必须是 **0**，而不是 500 或 1 000。
   */
  async function checkInflightRollback() {
    backend.calls = 0;
    backend.setEntries(MAX_RENDER + 5);
    const host = newHost();
    const dl = window.rmd.docList.createDocList({
      host: host,
      onOpenFile: function () {},
      keyText: function () { return ''; },
    });
    dl.setActive(true);

    const p1 = dl.refresh();
    // 让第一份的回包到达（首片 500 行同步画出，其余排进定时器）
    await tick();
    const firstChunk = rowsOf(host);

    const hold = deferred();
    backend.holds.push(hold);
    const p2 = dl.refresh();          // ⚠️ 令牌前进，回包被挂住
    await sleep(80);                  // 让旧分片的定时器到期

    const during = rowsOf(host);

    hold.resolve();
    await p2;
    await tick();
    // 等新的一份画完
    for (let i = 0; i < 60 && rowsOf(host) < MAX_RENDER; i++) await tick();
    const after = rowsOf(host);

    dl.destroy();
    await p1;

    const ok = firstChunk > 0 && during === 0 && after === MAX_RENDER;
    return {
      判据: 'D 刷新在途时旧分片回滚（0 行残留）',
      首片行数: firstChunk,
      在途期间残留: during,
      刷新后行数: after,
      ok: ok,
    };
  }

  // ── 主流程 ───────────────────────────────────────────────────────────

  async function run() {
    installBackend();
    await window.rmd.session.refresh();

    const out = {
      环境: {
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
        容器宽: CONTAINER_W,
        容器高: CONTAINER_H,
        轮数: ROUNDS,
        被测源码: [
          'src/services/i18n.js',
          'src/services/versions.js',
          'src/services/chunked.js',
          'src/services/doclists.js',
          'src/services/session.js',
          'src/components/DocList.js',
        ],
        样式: ['styles/tokens.css', 'styles/themes.css', 'styles/typography.css', 'styles/sidebar.css'],
        分片参数: {
          CHUNK_FIRST: window.rmd.versions.CHUNK_FIRST,
          CHUNK_STEP: window.rmd.versions.CHUNK_STEP,
          MAX_RENDER: MAX_RENDER,
        },
        // ⚠️ 键名必须都是合法标识符：一个 `⚠️` 当键名会让**整份文件解析失败**，
        //    而表现是"窗口里什么都没发生"、`__LOADERR` 也是空的（首跑踩过）。
        注意: '假后端 ⇒ 不含真 IPC 与上屏；布局已强制；⛔ 内存未量',
      },
      结果: [],
      判据: [],
    };

    for (let k = 0; k < N_LIST.length; k++) {
      const n = N_LIST[k];
      const rounds = [];
      let rowH = -1;
      let scrollH = -1;
      for (let r = 0; r < ROUNDS; r++) {
        const one = await runOnce(n);
        rounds.push(one);
        if (r === 0) {
          const host = document.getElementById('doclist-probe-host');
          const first = host ? host.querySelector('.doclist-row') : null;
          rowH = first ? +first.getBoundingClientRect().height.toFixed(2) : -1;
          scrollH = host ? host.scrollHeight : -1;
        }
        await sleep(40); // 让上一轮的定时器/观察器彻底安静
      }
      const okRounds = rounds.filter(function (x) { return !x.超时; });
      const entry = {
        行数: n,
        行高: rowH,
        容器scrollHeight: scrollH,
        行数_实际: rounds[0].行数,
        说明行数: rounds[0].说明行数,
        首批可见: okRounds.length ? median(okRounds.map(function (x) { return x.首批可见; })) : -1,
        全部完成: okRounds.length ? median(okRounds.map(function (x) { return x.全部完成; })) : -1,
        超时轮数: rounds.length - okRounds.length,
        原始: rounds,
      };
      out.结果.push(entry);
      // 判据 A：正常量级下一行不少（1276 那条对齐 `notes/0032` §2 的语料）
      if (n === 1276) {
        out.判据.push({
          判据: 'A 1 276 行一行不少',
          期望: Math.min(n, MAX_RENDER),
          实测: entry.行数_实际,
          ok: entry.行数_实际 === Math.min(n, MAX_RENDER),
        });
        out.判据.push(checkRowClick(n, rounds[0]));
      }
    }

    out.判据.push(await checkTruncation());
    out.判据.push(await checkInflightRollback());

    return out;
  }

  window.__RUN = run;
  window.__LOADERR = [];
  window.addEventListener('error', function (e) {
    window.__LOADERR.push(String(e.message || e));
  });
})();
