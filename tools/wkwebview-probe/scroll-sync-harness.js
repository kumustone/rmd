// rmd · 左右滚动同步的**真 DOM 离屏探针**（页面侧，`design/0012` §11.6/§11.7）
//
// 为什么有这一份：`tests/js/sync.test.js` 的**纯逻辑**那 35 条能在 node 里跑，
// 但 §11 里真正会坏的地方在**接线**——监听、观察器、rAF 合流、夹取、拆卸。
// 那些要真 DOM、真 CodeMirror 6、真滚动容器。而本仓库的"两端各写一半的契约"
// 已经有三个成员（`docs/bugs/0003`/`0004`/`0005`），形态全是"两边各自都有测试，
// 断的是中间那一跳" ⇒ 这一层**必须有**断言。
//
// ⭐ **它跑的是产品那一份 `src/services/sync.js`**（`.sh` 从仓库里原样拷进来），
//    ⛔ 探针不抄第二份实现。同理 CM6 用的是产品那份 `src/vendor/cm6.bundle.js`。
//
// ⚠️ **只断言、不量数**：⛔ 这不是基准探针，结果不进 `benchmarks/results/`
//    （那边是历史记录，见 `docs/README.md` §6）。判据进退出码。
//
// ⚠️⚠️ **两条环境自证（E1/E2）挡在前面**：离屏窗口（`alphaValue = 0`）里
//    WKWebView **不保证**给 rAF 与 `scroll` 事件（`cm6-probe.swift` 第一版就挂在
//    "等 rAF 永不回调"上，`kb/0022` 才把口径改成"可以用，但每次都要自证"）。
//    ⇒ 依赖它们的那几条在自证失败时记**「跳过」而不是「失败」**——
//    "环境不成立"与"实现坏了"是两件事，混起来会得到一条**会骗人**的红。
//
// ⚠️ **探针手搭的预览 DOM**：右侧那一栏是 `innerHTML` 手写的（高度刻意不均），
//    ⛔ 不是 comrak 渲的。§11 的映射只吃"标题在内容里的位置"这一个输入，
//    而手搭能把"节高不均"这件事**确定下来**（真 comrak 的输出会随版本漂）。
//    ⇒ 结论只对 `sync.js` 那一层有效，⛔ **不覆盖 comrak 的排版高度**。

(function () {
  'use strict';

  const 标题数 = 7;
  /** 源码里每个标题后的填充行数（刻意不均：让 a 轴的间隔也不均）。 */
  const 填充行 = [3, 1, 9, 2, 14, 5, 20];
  /** 预览里每节的高度（px，刻意不均：**这正是折线存在的理由**）。 */
  const 节高 = [60, 320, 90, 520, 140, 700, 200];
  /** 落在 `[lo, hi]` 内的浮点相等容差（px）。
   *  ⚠️ 为什么是 3 而不是 1：滚动位置会被设备像素量化（赋值 `123.4` 可能落到 `123`），
   *  而**段内斜率**会把它放大——夹具刻意让节高不均，最陡那一段 `Δb/Δa ≈ 3`。
   *  ⇒ 量化 1 px 在预览侧就是 3 px。⛔ 别为了"数好看"把它收到 1（会得到一条会闪红的闸门）。 */
  const 容差 = 3;

  const S = window.rmd.sync;
  const CM6 = window.rmdCM6;

  // ══════════════ 小工具 ══════════════

  /** 数值 → 两位小数（⛔ `undefined`/`NaN` 一律落 `null`：桥只吃 JSON 类型）。 */
  function 数(x) {
    return (typeof x === 'number' && isFinite(x)) ? Math.round(x * 100) / 100 : null;
  }
  /** 歇 ms。⚠️ 让出事件循环一律用它，⛔ 不用 rAF——rAF 在离屏窗口里可能不来。 */
  function 歇(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  /** 轮询到条件成立或超时。返回是否成立。 */
  function 等(cond, ms) {
    return new Promise(function (res) {
      const t0 = performance.now();
      (function 试() {
        let ok = false;
        try { ok = !!cond(); } catch (e) { ok = false; }
        if (ok) return res(true);
        if (performance.now() - t0 > ms) return res(false);
        setTimeout(试, 16);
      })();
    });
  }
  /**
   * 等 n 帧。
   *
   * ⚠️⚠️ **兜底必须走 `setTimeout`，⛔ 不能只靠"帧里那个时间判据"**——
   *    rAF 一次都不来时，那个判据**根本没机会跑**（它自己就在帧回调里）
   *    ⇒ Promise 永不 settle ⇒ 整个探针挂死。
   *    ⭐ 第一版就是这么写的，实测挂在 swift 那侧的 150 秒兜底上：
   *    `cm6-probe.swift` 头里那条"不可见窗口等 rAF 会永不回调"的教训
   *    在这里换了个形态又出现了一次。
   */
  function 帧(n, 兜底ms) {
    return new Promise(function (res) {
      const t0 = performance.now();
      const 限 = 兜底ms || 3000;
      let i = 0, done = false;
      function 收(ok) { if (done) return; done = true; res({ ok: ok, 用时: 数(performance.now() - t0) }); }
      setTimeout(function () { 收(false); }, 限 + 200);      // ⭐ 唯一与帧无关的出口
      function 步() {
        if (done) return;
        if (i >= n) return 收(true);
        if (performance.now() - t0 > 限) return 收(false);
        i += 1;
        requestAnimationFrame(步);
      }
      requestAnimationFrame(步);
    });
  }
  /** 数 ms 内的 rAF 帧数（E1 的环境自证）。 */
  function 数帧(ms) {
    return new Promise(function (res) {
      const ts = [], t0 = performance.now();
      let done = false;
      function 收(超时) {
        if (done) return;
        done = true;
        const gaps = [];
        for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
        gaps.sort(function (a, b) { return a - b; });
        res({
          帧数: ts.length,
          中位间隔: gaps.length ? 数(gaps[Math.floor(gaps.length / 2)]) : null,
          最长间隔: gaps.length ? 数(gaps[gaps.length - 1]) : null,
          超时: !!超时,
        });
      }
      setTimeout(function () { 收(true); }, ms + 1500);
      function 步(t) {
        if (done) return;
        ts.push(t);
        if (performance.now() - t0 >= ms) return 收(false);
        requestAnimationFrame(步);
      }
      requestAnimationFrame(步);
    });
  }
  /** 元素顶端相对某滚动容器**边框盒**顶端的距离（同 `headingPositions` 那把尺子）。 */
  function 落点(el, host) {
    if (!el || !host) return null;
    return 数(el.getBoundingClientRect().top - host.getBoundingClientRect().top);
  }
  /** 一个滚动容器的可滚上界（与 `sync.js::上界` 同一算式，仅为探针读数用）。 */
  function 上界(el) {
    if (!el) return 0;
    return Math.max(0, el.scrollHeight - el.clientHeight);
  }

  // ══════════════ 夹具 ══════════════

  /**
   * 造源码 Markdown。⭐ **行号是算出来的**（`toc[].line` 逐条对得上真文本），
   * ⛔ 不是写死的常量——那样"行号换算"这件事就没被测到。
   */
  function 造源码() {
    const lines = ['# 探针文档', ''];
    const toc = [];
    for (let k = 0; k < 标题数; k++) {
      const n = k + 1;
      toc.push({ id: 'h' + n, line: lines.length + 1 });   // 下一行就是它（行号从 1 起）
      lines.push('## 标题 ' + n);
      lines.push('');
      for (let i = 0; i < 填充行[k]; i++) lines.push('填充 ' + n + '·' + i + '：一行占一行的文本。');
      lines.push('');
    }
    return { text: lines.join('\n'), toc: toc, 行数: lines.length };
  }

  /** 手搭右侧预览：`#doc` 里按「首块 → (标题 → 节高) × N」摆。 */
  function 造预览(docEl, toc) {
    docEl.innerHTML = '';
    const 头 = document.createElement('div');
    头.className = 'pad';
    头.style.height = '180px';
    头.textContent = '（首标题之前）';
    docEl.appendChild(头);
    for (let i = 0; i < toc.length; i++) {
      const h = document.createElement('h2');
      h.id = toc[i].id;
      h.textContent = '标题 ' + (i + 1);
      docEl.appendChild(h);
      const d = document.createElement('div');
      d.className = 'sec';
      d.style.height = 节高[i] + 'px';
      d.textContent = '（第 ' + (i + 1) + ' 节）';
      docEl.appendChild(d);
    }
  }

  // ══════════════ 装配 ══════════════

  window.__RUN = async function () {
    const 记 = [];
    function 存(id, 名, 判据, 结果, 值) {
      记.push({ id: id, 名: 名, 判据: 判据, 结果: 结果, 值: 值 || null });
    }

    const docEl = document.getElementById('doc');
    if (!docEl) {
      return { 致命: '页面里没有 #doc —— 生成页面的那段 .sh 与这份夹具对不上', 检查: 记 };
    }
    if (!S || typeof S.createDriver !== 'function') {
      return { 致命: 'window.rmd.sync 没有 createDriver —— src/services/sync.js 没被拷进页面？', 检查: 记 };
    }
    if (!CM6 || typeof CM6.EditorView !== 'function') {
      return { 致命: 'window.rmdCM6 不在 —— 产品那份 src/vendor/cm6.bundle.js 没被拷进页面？', 检查: 记 };
    }

    // ── 挂真 CM6（⛔ 不装 lineWrapping / 不装语言：行↔块要一一对应、且要快） ──
    const fx = 造源码();
    造预览(docEl, fx.toc);
    let view;
    try {
      view = new CM6.EditorView({
        state: CM6.EditorState.create({ doc: fx.text }),
        parent: document.getElementById('editor-host'),
      });
    } catch (e) {
      return { 致命: 'CM6 挂载失败：' + (e && e.message), 检查: 记 };
    }
    await 歇(30);

    const 源滚 = view.scrollDOM;    // ⭐ 与 `main.js::syncSrcElement` 同一个元素
    const 预滚 = docEl;             // ⭐ 与 `main.js::syncDstElement` 同一个元素

    /**
     * ⭐ **夹具的初始尺寸**——在**任何一个检查动过 DOM 之前**取。
     * ⚠️⚠️ 第一版是在汇总处现取的，于是 T6 往预览栏头部插了 400 px 之后，
     *    报出去的「预览侧内容高」是 **2806**（插过之后的），而判定用的夹具是 2406。
     *    读数与实测对不上，读的人只会以为夹具换了。
     */
    const 初尺寸 = {
      源码侧内容高: 数(源滚.scrollHeight), 源码侧视口高: 数(源滚.clientHeight),
      预览侧内容高: 数(预滚.scrollHeight), 预览侧视口高: 数(预滚.clientHeight),
    };

    // ⭐ 与 `main.js` 那四个取值器**同形**（⛔ 不另写一套语义）
    let tocNow = fx.toc.slice();
    let 领先 = false;               // = `syncTextAhead` 的反面
    let freshCalls = 0;
    const lineTop = function (line) { return S.sourceLineTopOf(view, line); };
    /** ⭐ 逐字复刻 `main.js::headingPositions` 的**元素宿主**那一支。 */
    function headingTops() {
      const base = 预滚.getBoundingClientRect().top - 预滚.scrollTop;
      const out = [];
      for (let i = 0; i < tocNow.length; i++) {
        const el = document.getElementById(tocNow[i].id);
        if (!el) continue;                       // ⚠️ 查不到就跳过（右侧表可能更短）
        out.push({ id: tocNow[i].id, top: el.getBoundingClientRect().top - base });
      }
      return out;
    }
    let 挂次数 = 0, 拆次数 = 0;

    /**
     * ⭐ **源码栏里代表某一行文本的那个 `.cm-line` 元素**（虚拟化感知）。
     *
     * ⚠️⚠️ CM6 只渲视口附近的行，所以**先把那一行滚进视口**（调用方负责），
     *    再按 `posAtDOM` 反查它——⛔ 不用 `domAtPos`：行没渲时它会给**最近**的
     *    那个节点，于是量到别的行而**看不出错**。
     * ⚠️ 返回 `null` 的意思只能是"滚过去之后它仍没渲出来"，那要**如实记**，
     *    ⛔ 不是"落点 0"。
     */
    function 源码行元素(from) {
      const 全部 = view.contentDOM.querySelectorAll('.cm-line');
      for (let i = 0; i < 全部.length; i++) {
        try { if (view.posAtDOM(全部[i], 0) === from) return 全部[i]; } catch (e) { /* 跳过 */ }
      }
      return null;
    }

    function onChange(cb) {
      挂次数 += 1;
      return function () { 拆次数 += 1; cb && 0; };
    }
    const driver = S.createDriver({
      src: function () { return 源滚; },
      dst: function () { return 预滚; },
      lineTop: lineTop,
      toc: function () { return tocNow; },
      headingTops: headingTops,
      fresh: function () { freshCalls += 1; return !领先; },
      onChange: onChange,
    });

    // ══════════════ E1 · rAF 自证（环境） ══════════════
    const e1 = await 数帧(1000);
    const e1ok = !e1.超时 && e1.帧数 >= 10 && e1.中位间隔 !== null && e1.中位间隔 <= 200;
    存('E1', '离屏窗口里 rAF 在跑', '1000 ms 内 ≥ 10 帧 ∧ 中位间隔 ≤ 200 ms', e1ok ? '通过' : '失败', e1);
    const 有raf = e1ok;

    // ══════════════ E2 · scroll 事件自证（环境） ══════════════
    let e2;
    {
      let 收到 = 0;
      const 听 = function () { 收到 += 1; };
      预滚.addEventListener('scroll', 听, { passive: true });
      const 原 = 预滚.scrollTop;
      预滚.scrollTop = Math.min(原 + 37, 上界(预滚));
      const 到 = await 等(function () { return 收到 > 0; }, 1500);
      预滚.removeEventListener('scroll', 听);
      预滚.scrollTop = 原;
      await 等(function () { return Math.abs(预滚.scrollTop - 原) < 容差; }, 800);
      e2 = { 收到: 收到, 事件到达: 到, 已复位: 数(预滚.scrollTop) };
    }
    存('E2', '离屏窗口里 scroll 事件会派发', '程序改 scrollTop 后收到 ≥ 1 条 scroll',
      e2.事件到达 ? '通过' : '失败', e2);
    const 有事件 = e2.事件到达;

    // ══════════════ E3 · 坐标系一致（`lineBlockAt().top` 与 `scrollTop` 同一把尺子） ══════════════
    // ⚠️⚠️ 这是 §11 唯一"押在 CM6 行为上"的假设。判据**不是**偏移为 0，而是
    //    **偏移对所有标题是同一个常数**——映射需要的正是"均匀平移"这一条。
    //    （`.cm-content` 有 padding ⇒ 预计有一个几像素的常数偏移，如实记下。）
    //
    // ⚠️ 取 `.cm-line` 元素的办法见上文 `源码行元素()`。
    let e3;
    {
      const 上界源 = 上界(源滚);
      const 测 = [];
      for (const t of fx.toc) {
        const from = view.state.doc.line(t.line).from;
        const blk = view.lineBlockAt(from);
        // ⚠️⚠️ **只量滚得到的行**：靠文档末尾的那几个标题，`blk.top` 比可滚上界还大，
        //    `scrollTop = blk.top` 会被**夹住** ⇒ 那一行根本到不了顶端，
        //    量出来的"落点"是 168/325 px，与坐标系没关系。
        //    ⛔ 第一版没排掉它们，于是 `极差` 变成 320 px、E3 假红——
        //    而根因是**夹具**（源码侧内容 1517 px、视口 780 px ⇒ 上界只有 737）。
        //    它们不是"错了"，是"这一条判据对它们不适用"，如实记进 `超出可滚范围`。
        if (blk.top > 上界源 + 0.5) {
          测.push({ 行: t.line, lineBlockAt_top: 数(blk.top), 上界: 数(上界源),
                    超出可滚范围: true });
          continue;
        }
        源滚.scrollTop = blk.top;            // 把这一行送到内容顶端
        await 帧(1, 800);
        const el = 源码行元素(from);
        if (!el) { 测.push({ 行: t.line, 缺: '滚到它之后仍没渲出来' }); continue; }
        // ⭐ 视觉落点 = 该行边框盒顶端离**滚动容器边框盒顶端**的距离
        测.push({
          行: t.line,
          lineBlockAt_top: 数(blk.top),
          写入的scrollTop: 数(源滚.scrollTop),
          视觉落点: 数(el.getBoundingClientRect().top - 源滚.getBoundingClientRect().top),
        });
      }
      const 好 = 测.filter(function (x) { return typeof x.视觉落点 === 'number'; });
      const 偏 = 好.map(function (x) { return x.视觉落点; });   // = 落点 − (blk.top − scrollTop)
      const 极差 = 偏.length ? 数(Math.max.apply(null, 偏) - Math.min.apply(null, 偏)) : null;
      const 排序 = 偏.slice().sort(function (a, b) { return a - b; });
      const 常数 = 排序.length ? 数(排序[Math.floor(排序.length / 2)]) : null;
      e3 = { 逐条: 测, 偏移: 偏.map(数), 偏移极差: 极差, 常数偏移: 常数,
             量到的行数: 好.length, 可滚上界: 数(上界源),
             超出可滚范围: 测.filter(function (x) { return x.超出可滚范围; }).map(function (x) { return x.行; }) };
    }
    const e3ok = e3.常数偏移 !== null && e3.偏移极差 !== null && e3.偏移极差 <= 3
      && e3.量到的行数 >= 3;      // ⚠️ 量到的行太少 ⇒ 这条判据是空的
    存('E3', 'lineBlockAt().top 与 scrollTop 同一把尺子',
      '把源码栏滚到 lineBlockAt().top ⇒ 该行的视觉落点对**每个够得着的标题都相同**（极差 ≤ 3 px）'
      + '，⛔ 不要求那个常数是 0；⚠️ 靠末尾那几条（`blk.top` 超出可滚上界）**不参与**判定',
      e3ok ? '通过' : '失败', e3);
    const 常数偏移 = e3.常数偏移 === null ? 0 : e3.常数偏移;
    源滚.scrollTop = 0;
    await 帧(2, 800);

    // ══════════════ T0 · 夹具的判别力（⚠️ 这条自己也可能骗人） ══════════════
    // ⭐ 如果"锚点折线"与"按比例"给出同一个数，后面所有落点断言都是**空的**。
    //    Q22 那次"第一版夹具根本不超限、5 条绿得毫无意义"就是同一族。
    let t0;
    {
      const maxA = 上界(源滚), maxB = 上界(预滚);
      const pairs = S.pairAnchors(fx.toc, headingTops(), lineTop);
      const knots = S.buildKnots(pairs, maxA, maxB);
      const 差 = [];
      for (const p of pairs) {
        差.push(数(Math.abs(S.mapValue(knots, p.a, 'a') - (maxA > 0 ? p.a * maxB / maxA : 0))));
      }
      const 最大差 = 差.length ? Math.max.apply(null, 差) : 0;
      t0 = { maxA: 数(maxA), maxB: 数(maxB), 锚点数: pairs.length, 折线点数: knots.length,
             逐锚点_折线减按比例: 差, 最大差: 数(最大差) };
      存('T0', '夹具具判别力：折线 ≠ 按比例',
        '至少一个锚点上 |折线 − 按比例| > 20 px（否则后面的落点断言是空的）',
        最大差 > 20 ? '通过' : '失败', t0);
    }

    // ══════════════ T1 · 装配 ══════════════
    driver.start();
    await 帧(2, 800);

    /**
     * ⭐ 折线里**真的用上了**哪些锚点（返回 `toc` 下标）。
     *
     * ⚠️ 为什么探针要自己算一遍：`buildKnots` 会丢掉**触到任一边界**的锚点
     *    （`p.a >= A || p.b >= B`）——夹具的内容长度与视口高度决定丢哪几个。
     *    ⛔ 不这么算，后面的落点断言就得**写死**几个下标，换个夹具就悄悄测不到东西。
     * ⚠️ 这不与 `driver` 的 `state()` 重复：那个只报**个数**，落点断言要的是**哪几条**。
     */
    function 存活锚点() {
      const pairs = S.pairAnchors(tocNow, headingTops(), lineTop);
      const knots = S.buildKnots(pairs, 上界(源滚), 上界(预滚));
      const 键 = Object.create(null);
      for (let i = 0; i < knots.length; i++) 键[knots[i].a + '|' + knots[i].b] = 1;
      const out = [];
      for (let i = 0; i < pairs.length; i++) {
        if (键[pairs[i].a + '|' + pairs[i].b]) out.push(i);
      }
      return { pairs: pairs.length, 存活: out };
    }
    /** ⭐ 从存活锚点里挑第 `分位` 个（避开贴边界的首末）。 */
    function 挑中间(分位) {
      const v = 存活锚点().存活;
      if (v.length === 0) return null;
      const i = Math.max(0, Math.min(v.length - 1, Math.round((v.length - 1) * 分位)));
      return v[i];
    }

    {
      const st = driver.state();
      const 活 = 存活锚点();
      const ok = st.running === true && st.exact === true &&
                 st.anchors === 标题数 &&                        // 采集：7 个标题全都配上了
                 st.used === 活.存活.length &&                   // 用上：与探针独立算出来的一致
                 st.used >= 3 &&                                 // ⚠️ 少于 3 条落点断言就没意义了
                 (st.knots === st.used + 1 || st.knots === st.used + 2) &&
                 st.origin === null;
      存('T1', '装配：折线真的用上了锚点',
        'running ∧ exact ∧ 采集锚点 = 标题数 ∧ 用上的锚点数 = 探针独立算出的存活数（≥3）'
        + ' ∧ 折线点数 = 用上数 + 0~1 个端点 ∧ 来源为 null（还没人滚）',
        ok ? '通过' : '失败',
        { state: st, 标题数: 标题数, 探针算的存活: 活.存活, 探针算的采集: 活.pairs });
    }

    /** ⭐ 把源码栏滚到某个标题所在行，等**真事件**走完。 */
    async function 滚源码到标题(k) {
      const t = fx.toc[k];
      const a = lineTop(t.line);
      if (a === null) return null;
      源滚.scrollTop = a;
      await 帧(3, 1200);
      await 歇(60);          // ⚠️ 给异步到达的 scroll 事件留窗口（§11.4 就是为它写的）
      return a;
    }
    /** ⭐ 预览栏里标题 k 的落点（相对 `#doc` 边框盒顶端）。 */
    function 预览落点(k) {
      const el = document.getElementById(fx.toc[k].id);
      return 落点(el, 预滚);
    }

    // ══════════════ T2 · 左 → 右 ══════════════
    let t2;
    {
      const 选 = [挑中间(0.25), 挑中间(0.5), 挑中间(0.75)].filter(function (x) { return x !== null; });
      const 逐条 = [];
      for (const k of 选) {
        const a = await 滚源码到标题(k);
        if (a === null) { 逐条.push({ 标题: k, 错: 'lineTop 为 null' }); continue; }
        逐条.push({
          标题: k, 锚点_源码px: 数(a), 锚点_预览px: 数(预滚.scrollTop),
          预览落点: 预览落点(k),
        });
      }
      const 好 = 逐条.filter(function (x) { return typeof x.预览落点 === 'number'; });
      const 最大 = 好.length ? Math.max.apply(null, 好.map(function (x) { return Math.abs(x.预览落点); })) : null;
      t2 = { 选的标题: 选, 逐条: 逐条, 最大落点偏差: 数(最大) };
      存('T2', '左 → 右：对应标题落在预览栏顶部',
        '滚源码栏到标题所在行 ⇒ 该标题在预览栏离顶部 ≤ ' + 容差 + ' px（抽样 3 个存活锚点）',
        (选.length === 3 && 好.length === 3 && 最大 <= 容差) ? '通过' : '失败', t2);
    }

    // ══════════════ T4 · 防反弹（⛔ 不许用"正在写"的布尔锁） ══════════════
    // ⚠️⚠️ 这条是用户边界的原话：「程序滚动事件可能延后到达，不能只在赋值期间设一个同步布尔锁」。
    //    ⇒ 写完之后**等真帧 + 等真事件**，再断言三样都没动：源码栏、预览栏、来源。
    let t4;
    {
      const k = 挑中间(0.5);
      const a = await 滚源码到标题(k);
      const 前 = { 源: 数(源滚.scrollTop), 预: 数(预滚.scrollTop), 来源: driver.state().origin };
      await 帧(6, 2000);
      await 歇(200);
      const 后 = { 源: 数(源滚.scrollTop), 预: 数(预滚.scrollTop), 来源: driver.state().origin,
                   预览落点: 预览落点(k) };
      const 没动 = 前.源 === 后.源 && 前.预 === 后.预 && 前.来源 === 后.来源;
      t4 = { 标题: k, 锚点_源码px: 数(a), 写后: 前, 六帧后: 后, 一动没动: 没动 };
      存('T4', '防反弹：程序写完六帧之后两边都不动',
        '源码栏 / 预览栏 / 来源三者**逐字不变**，且预览落点仍 ≤ ' + 容差 + ' px',
        (k !== null && 没动 && Math.abs(后.预览落点) <= 容差) ? '通过' : '失败', t4);
    }

    // ══════════════ T5 · 迟到的旧回声（连续驱动） ══════════════
    // ⭐ 记一串写过的值（`ECHO_KEEP`）而不是只记最后一个，正是为这一条。
    let t5;
    {
      const 序 = [];
      const 选 = [挑中间(0), 挑中间(0.6), 挑中间(1), 挑中间(0.4)]
        .filter(function (x, i, arr) { return x !== null && arr.indexOf(x) === i; });
      for (const k of 选) {
        const a = await 滚源码到标题(k);
        序.push({ 标题: k, 源码px: 数(a), 预览px: 数(预滚.scrollTop) });
        await 帧(2, 1200);                    // ⚠️ 不给足就让"迟到"这件事测不出来
      }
      await 帧(4, 2000);
      await 歇(200);
      const 末 = 序[序.length - 1];
      const 稳 = 末 && Math.abs(预滚.scrollTop - (末.预览px === null ? 0 : 末.预览px)) <= 容差;
      t5 = { 序列: 序, 末尾预览px: 数(预滚.scrollTop), 停在最后一次: 稳,
             预览落点: 预览落点(末 ? 末.标题 : 0), 来源: driver.state().origin };
      存('T5', '迟到的旧回声不把预览拽回去',
        '连续驱动四次后，预览栏停在**最后一次**的值上 ±' + 容差 + ' px，来源仍 `src`',
        (序.length === 选.length && 选.length >= 3 && 稳 && t5.来源 === 'src' &&
         Math.abs(t5.预览落点) <= 容差) ? '通过' : '失败', t5);
    }

    // ══════════════ T3 · 右 → 左（双向 + 及时移交） ══════════════
    // ⭐ 用户边界的原话：「用户切到另一栏主动滚动时，应及时移交控制权」。
    //    这里派一个**真 `wheel`**（拖滚动条的替代：`pointerdown` 是另一条，纯逻辑已测），
    //    然后设 `scrollTop` ⇒ 来源必须换成 `dst`，并由它驱动源码栏。
    let t3;
    {
      const k = 挑中间(0.5);
      const b = headingTops().filter(function (x) { return x.id === fx.toc[k].id; })[0];
      const a3 = lineTop(fx.toc[k].line);      // ⭐ 该标题在**源码侧**的内容坐标（= 折线的锚点 a）
      const 原来源 = driver.state().origin;
      预滚.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }));
      const 移交后 = driver.state().origin;
      if (b && b.top > 0) 预滚.scrollTop = b.top;
      await 帧(3, 1200);
      await 歇(80);
      const 视 = 落点(源码行元素(view.state.doc.line(fx.toc[k].line).from), 源滚);
      // ⚠️⚠️ 期望值只能取**E3 量到的那一行自己的落点**（`blk.top` 与"贴住视口顶端"
      //    差的就是 `.cm-content` 的内边距）。⛔ 第一版这里写的是
      //    `document.getElementById(fx.toc[k].id)`——那是**预览栏**的 `<h2>`，
      //    却被拿去对**源码栏**的容器量距离 ⇒ 量到的是"预览标题离它自己栏顶多远"
      //    （驱动到位时恒为 0），于是**红了一条其实是对的断言**。
      const e3行 = (e3.逐条 || []).filter(function (x) { return x.行 === fx.toc[k].line; })[0];
      const 期望 = (e3行 && typeof e3行.视觉落点 === 'number') ? e3行.视觉落点 : 常数偏移;
      t3 = { 标题: k, 源行: fx.toc[k].line, 移交前来源: 原来源, 移交后来源: 移交后,
             现在来源: driver.state().origin,
             预览px: 数(预滚.scrollTop), 锚点_预览px: 数(b ? b.top : null),
             源码px: 数(源滚.scrollTop), 锚点_源码px: 数(a3),
             源码落点_相对视口: 视, 期望落点: 数(期望),
             偏差: 数(typeof 视 === 'number' ? Math.abs(视 - 期望) : null) };
      存('T3', '右 → 左：动预览栏会把源码栏带到对应行',
        '`wheel` 之后来源换成 `dst`；★ 源码栏真的滚到该标题那一行（`scrollTop` ≈ `blk.top`，'
        + '±1 px 量化）★ 且那一行**视觉上也贴在栏顶**（落在 E3 量到的、属于这一行自己的那个'
        + '落点 ± ' + 容差 + ' px）',
        (t3.移交后来源 === 'dst' && t3.现在来源 === 'dst' &&
         typeof t3.偏差 === 'number' && t3.偏差 <= 容差 &&
         t3.锚点_源码px !== null && Math.abs(t3.源码px - t3.锚点_源码px) <= 1) ? '通过' : '失败', t3);
    }

    // ══════════════ T6 · 布局变化：内容变了（MutationObserver） ══════════════
    // ⚠️ `ImageView` 把占位符换成真 `<img>` 时，`#doc` **自己的边框盒一个像素都没变**
    //    ⇒ `ResizeObserver` 看不到它。这条钉的就是这个观察器。
    let t6;
    if (!有raf) {
      存('T6', '内容变 ⇒ 重建折线（MutationObserver）', '需要 rAF', '跳过', { 原因: 'E1 未通过：离屏窗口里 rAF 没跑起来' });
    } else {
      const 前 = { 预览px: 数(预滚.scrollTop), fresh: freshCalls };
      const 块 = document.createElement('div');
      块.style.height = '400px';
      块.textContent = '（模拟一张图加载完，把下面全推下去 400 px）';
      预滚.insertBefore(块, 预滚.firstChild);
      const 等到 = await 等(function () { return freshCalls > 前.fresh; }, 2500);
      const k = 挑中间(0.5);
      const a = await 滚源码到标题(k);
      const st = driver.state();
      const 后 = { 预览px: 数(预滚.scrollTop), fresh: freshCalls, 用上: st.used, 采集: st.anchors,
                   预览落点: 预览落点(k) };
      t6 = { 插入前: 前, 插入后: 后, 等到重建: 等到, 标题: k, 锚点_源码px: 数(a),
             探针算的存活: 存活锚点().存活,
             推下去多少: 数((后.预览px === null || 前.预览px === null) ? null : 后.预览px - 前.预览px) };
      存('T6', '内容变 ⇒ 重建折线（MutationObserver）',
        '往预览栏头部插 400 px ⇒ 折线重建（`fresh` 调用数增加，⛔ 不是"DOM 变了就自动对"）'
        + '，且新映射照样对齐 ≤ ' + 容差 + ' px',
        (等到 && st.used >= 3 && st.used === 存活锚点().存活.length &&
         Math.abs(后.预览落点) <= 容差) ? '通过' : '失败', t6);
    }

    // ══════════════ T7 · 布局变化：尺寸变了（ResizeObserver） ══════════════
    let t7;
    if (!有raf) {
      存('T7', '容器尺寸变 ⇒ 重建折线（ResizeObserver）', '需要 rAF', '跳过', { 原因: 'E1 未通过' });
    } else {
      // ⚠️ 先复位高度，免得 T6 那次插入把内容撑过头
      预滚.style.height = '780px';
      await 帧(2, 1000);
      const 前 = { fresh: freshCalls, 上界: 数(上界(预滚)) };
      预滚.style.height = '500px';
      const 等到 = await 等(function () { return freshCalls > 前.fresh; }, 2500);
      const k = 挑中间(0.5);
      const a = await 滚源码到标题(k);
      const st = driver.state();
      const 后 = { fresh: freshCalls, 上界: 数(上界(预滚)), 用上: st.used, 采集: st.anchors,
                   预览落点: 预览落点(k), 折线点数: st.knots };
      t7 = { 改前: 前, 改后: 后, 等到重建: 等到, 标题: k, 锚点_源码px: 数(a) };
      存('T7', '容器尺寸变 ⇒ 重建折线（ResizeObserver）',
        '预览栏 780 → 500 px ⇒ 折线重建且新映射照样对齐 ≤ ' + 容差 + ' px'
        + '（⚠️ 上界变了 ⇒ 折线的端点也变了）',
        (等到 && st.used >= 3 && st.used === 存活锚点().存活.length &&
         Math.abs(后.预览落点) <= 容差) ? '通过' : '失败', t7);
    }

    // ══════════════ T8 · 不可滚的一栏 ══════════════
    let t8;
    {
      预滚.style.height = '8000px';           // 内容全放得下 ⇒ 上界 = 0
      await 帧(2, 1000);
      await 歇(60);
      driver.rebuild();
      const 上界前 = 数(上界(预滚));
      let 抛 = null;
      try {
        const a = await 滚源码到标题(3);
        t8 = { 上界: 上界前, 锚点_源码px: 数(a) };
      } catch (e) { 抛 = String(e && e.message); t8 = { 上界: 上界前 }; }
      await 帧(2, 1000);
      t8.预览px = 数(预滚.scrollTop);
      t8.折线点数 = driver.state().knots;
      t8.锚点_用上 = driver.state().used;
      t8.锚点_采集 = driver.state().anchors;
      t8.exact = driver.state().exact;
      t8.抛错 = 抛;
      存('T8', '不可滚的一栏：退化 + 夹取，⛔ 不抛，⛔ 汇报不许说"精确"',
        '预览栏上界为 0 ⇒ 折线只剩 (0,0)、**用上的锚点 0**（⛔ 采集数仍是 7，'
        + '两个数**必须分开报**）、exact=false、预览栏恒 0，且不抛异常',
        (!抛 && 上界前 === 0 && t8.折线点数 === 1 && t8.锚点_用上 === 0 &&
         t8.锚点_采集 === 标题数 && t8.exact === false && t8.预览px === 0) ? '通过' : '失败', t8);
      预滚.style.height = '780px';
      await 帧(2, 1000);
    }

    // ══════════════ T9 · 无标题文档 ⇒ 按比例 ══════════════
    let t9;
    {
      const 原 = tocNow;
      tocNow = [];
      driver.rebuild();
      const 无标题 = { exact: driver.state().exact, 用上: driver.state().used,
                       采集: driver.state().anchors, 折线点数: driver.state().knots };
      const a = lineTop(fx.toc[3].line);
      源滚.scrollTop = a;
      await 帧(3, 1200);
      await 歇(60);
      const 比例 = { 源码px: 数(源滚.scrollTop), 预览px: 数(预滚.scrollTop), 上界: 数(上界(预滚)) };
      tocNow = 原;
      driver.rebuild();
      const 恢复 = { exact: driver.state().exact, 用上: driver.state().used };
      t9 = { 无标题时: 无标题, 按比例滚动: 比例, 恢复后: 恢复 };
      存('T9', '无标题文档 ⇒ 按比例（且不假装精确）',
        '`toc` 为空 ⇒ exact=false、用上的锚点 0、折线 2 点；滚源码栏时预览栏按比例跟且不抛',
        (无标题.exact === false && 无标题.用上 === 0 && 无标题.采集 === 0 &&
         无标题.折线点数 === 2 && 比例.预览px > 0 && 恢复.exact === true) ? '通过' : '失败', t9);
    }

    // ══════════════ T10 · 预览落后于源码 ⇒ 降级 ══════════════
    // ⭐ 用户边界的原话：「预览落后于源码时，不得把旧行号映射当作当前精确位置使用」。
    let t10;
    {
      领先 = true;
      driver.rebuild();
      const 落后 = { exact: driver.state().exact, 用上: driver.state().used,
                     采集: driver.state().anchors, 折线点数: driver.state().knots };
      领先 = false;
      driver.rebuild();
      const 追平 = { exact: driver.state().exact, 用上: driver.state().used,
                     采集: driver.state().anchors };
      t10 = { 领先时: 落后, 追平后: 追平, 恢复后探针算的存活: 存活锚点().存活.length };
      存('T10', '预览落后于源码 ⇒ 折线降级为按比例',
        '`fresh()` 为假 ⇒ exact=false、**折线只剩两端点、而且连采集都不做**（采集数 0、'
        + '用上 0）——旧渲染的 `line` 属于**上一次的文本**，拿它当当前源码行号是静默错；'
        + '⚠️ 这与 T8 是**两种不同的 0**：T8 采到了 7 个、被 `buildKnots` 丢光，'
        + '这里是**根本没采**。恢复为真 ⇒ 精确回来（采集与用上都回到 7 那一档）',
        (落后.exact === false && 落后.用上 === 0 && 落后.采集 === 0 &&
         落后.折线点数 === 2 && 追平.exact === true && 追平.采集 === 标题数 &&
         追平.用上 === 存活锚点().存活.length) ? '通过' : '失败', t10);
    }

    // ══════════════ T13 · 两端的端点饱和：到底 ⇄ 到底，⛔ 不外推也⛔ 不提前停 ══════════════
    // ⭐ 守的是 `buildKnots` 补上去的**那两个端点**（`(0,0)` 与 `(A,B)`）与 `mapValue`
    //    的端点饱和。⚠️ 没有这两样，锚点折线**只**在锚点之间说得通：
    //    源码栏滚到底时预览栏会**停在最后一个标题那里**（夹具里差着近千像素），
    //    而"差一点点"在屏幕上**看不出来**——它看起来只是"还没滚到底"。
    //    ⛔ 第一版**一条检查都没守它**（变异测试 M8 实测：去掉尾点，一条都不红）。
    let t13;
    {
      const maxA = 上界(源滚), maxB = 上界(预滚);
      源滚.scrollTop = maxA;
      await 帧(3, 1200);
      await 歇(80);
      const 到底 = { 源码px: 数(源滚.scrollTop), 上界源码: 数(maxA),
                     预览px: 数(预滚.scrollTop), 上界预览: 数(maxB) };
      源滚.scrollTop = 0;
      await 帧(3, 1200);
      await 歇(80);
      const 到顶 = { 源码px: 数(源滚.scrollTop), 预览px: 数(预滚.scrollTop) };
      t13 = { 到底: 到底, 到顶: 到顶, 锚点用上: driver.state().used };
      存('T13', '两端饱和：源码栏到底 ⇒ 预览栏也到底；回顶 ⇒ 预览也回顶',
        '滚到源码栏**自己的上界** ⇒ 预览栏恰好落在**它的**上界上（±1 px 量化）'
        + '，⛔ 不是"停在最后一个标题"；回 0 ⇒ 预览也回 0。'
        + '（守 `buildKnots` 补的两个端点与 `mapValue` 的端点饱和，⛔ 不外推）',
        (maxA > 0 && maxB > 0 && Math.abs(到底.预览px - 到底.上界预览) <= 1 &&
         到顶.预览px === 0 && 到底.源码px === 到底.上界源码) ? '通过' : '失败', t13);
    }

    // ══════════════ T12 · 折线是旧的 + 上界变小 ⇒ **必须夹到有效范围**，且不许误判成"用户移交" ══════════════
    // ⭐ 守的是用户边界第 2 条的尾句「**所有结果夹取到有效滚动范围**」。
    //    这一段构造的正是"折线已经过期"那种情形：只改**子孙元素的 style**（属性变化），
    //    ⛔ `MutationObserver` 的配置里没有 `attributes`、`#doc` 自己的边框盒又**没变**
    //    ⇒ 两个观察器都看不见 ⇒ 折线里的 `B` 比**现在**的上界大。
    //
    // ⚠️⚠️ 判据为什么**不是**"预览栏有没有超界"：`el.scrollTop = 超界值` 是**浏览器**替你夹的，
    //    所以"没超界"这件事**永远成立**、什么都证明不了。真正的分岔在回声环那一侧：
    //    `noteWrite` 记的是**打算写的值**，浏览器实际落的是**夹过之后的值**
    //    ⇒ 不夹的话这两个数对不上 ⇒ `scroll` 事件被当成"用户用别的方式动了它"
    //    ⇒ **来源被误判成 `dst`**。⭐ 于是判据是「来源不许翻」。
    let t12;
    {
      // ── 先立一个来源，并把预览栏停在一个**小的**位置上（免得下面缩内容时它被浏览器夹） ──
      源滚.scrollTop = lineTop(fx.toc[0].line);
      await 帧(3, 1200);
      await 歇(80);
      const 前 = { fresh: freshCalls, 上界预览: 数(上界(预滚)), 预览px: 数(预滚.scrollTop),
                   来源: driver.state().origin };
      // ── 只改属性 ⇒ 两个观察器都不该响（内容缩 ~1000 px，上界从 1626 掉到 ~626） ──
      const 节 = 预滚.querySelectorAll('.sec');
      if (节.length >= 6) {
        节[3].style.height = '20px';      // 520 → 20
        节[5].style.height = '200px';     // 700 → 200
      }
      await 帧(3, 1200);
      await 歇(80);
      const 中 = { fresh: freshCalls, 上界预览: 数(上界(预滚)) };
      const 没重建 = 中.fresh === 前.fresh;
      const 上界还够 = 中.上界预览 > 前.预览px;      // 现在这个位置仍在范围内 ⇒ 不会被浏览器夹
      // ── 滚到源码栏的可滚上界 ⇒ **旧折线**算出来的 b 会超过现在的上界 ──
      源滚.scrollTop = 上界(源滚);
      await 帧(3, 1200);
      await 歇(200);
      const 后 = { 上界预览: 数(上界(预滚)), 预览px: 数(预滚.scrollTop),
                   来源: driver.state().origin, 源码px: 数(源滚.scrollTop),
                   折线点数: driver.state().knots };
      t12 = { 缩之前: 前, 缩之后: 中, 没重建: 没重建, 当前位置仍在范围内: 上界还够, 驱动之后: 后 };
      if (!没重建 || !上界还够) {
        // ⚠️ 前提不成立就**如实记跳过**，⛔ 不要改判据去凑一个绿：
        //    这条守的"旧折线"前提没了，它测的东西就不是它想测的那个。
        存('T12', '旧折线 + 上界变小 ⇒ 写入必须夹到有效范围、且不许误判成"用户移交"',
          '前提：改属性**不触发**重建、且缩完之后当前位置仍在范围内（⛔ 前提不成立就不判）',
          '跳过', { 原因: 没重建 ? '当前位置被浏览器夹了 ⇒ 夹具不成立' : '观察器把属性变化也看见了 ⇒ 没有"旧折线"',
                    值: t12 });
      } else {
        存('T12', '旧折线 + 上界变小 ⇒ 写入必须夹到有效范围、且不许误判成"用户移交"',
          '只改属性（观察器看不见）⇒ 折线的 `B` 比现在的上界大；此时滚源码栏到底 ⇒'
          + '预览栏落在**现在**的上界上（⛔ 不是被浏览器夹出来的那个值），'
          + '⭐ 且来源**仍然是 `src`**（写进去的与回声环记的必须是同一个数）',
          (后.预览px === 中.上界预览 && 后.来源 === 'src') ? '通过' : '失败', t12);
      }
      // ── 复位夹具 ──
      if (节.length >= 6) { 节[3].style.height = 节高[3] + 'px'; 节[5].style.height = 节高[5] + 'px'; }
      await 帧(3, 1200);
      await 歇(80);
      driver.rebuild();
      源滚.scrollTop = 0;
      预滚.scrollTop = 0;
      await 帧(2, 1000);
    }


    let t11;
    {
      const 拆前 = 拆次数;
      driver.stop();
      const 停后 = driver.state();
      // ⚠️ 先把两栏都摆到 0——**在 stop 之后**摆（此时没有监听，摆谁都只动自己）。
      //    ⛔ 不能在 stop 之前摆：那会驱动另一栏，"停后预览栏不动"这条就无从判起。
      源滚.scrollTop = 0;
      预滚.scrollTop = 0;
      await 帧(2, 1000);
      await 歇(80);
      源滚.scrollTop = 400;
      await 帧(2, 1000);
      await 歇(80);
      const 预览px = 数(预滚.scrollTop);
      const 拆次数_停 = 拆次数;
      // 再起一次：应当重新装上、来源清空、折线重建
      driver.start();
      await 帧(2, 1200);
      const 再起 = driver.state();
      driver.stop();
      t11 = { 停后state: 停后, 拆订次数_停前: 拆前, 拆订次数_停后: 拆次数_停,
              停后滚源码栏_预览px: 预览px, 再起state: 再起 };
      存('T11', '拆装：stop 之后不再驱动，再 start 能重来',
        'stop ⇒ running=false ∧ 退订被调用 ∧ 滚源码栏预览栏不动；'
        + '再 start ⇒ 重新装上（用上的锚点 ≥ 3）且来源清空',
        (停后.running === false && 拆次数_停 > 拆前 && 预览px === 0 &&
         再起.running === true && 再起.used >= 3 && 再起.origin === null) ? '通过' : '失败', t11);
    }

    // ══════════════ 汇总 ══════════════
    const 失败 = 记.filter(function (x) { return x.结果 === '失败'; }).length;
    const 跳过 = 记.filter(function (x) { return x.结果 === '跳过'; }).length;
    return {
      环境: {
        // ⚠️ 这两个是**页面自己报的**；"窗口在不在屏上/抢没抢前台"由 swift 那侧补
        //    （它读的是 `NSWindow.isVisible` 与 `NSWorkspace.frontmostApplication`）。
        //    ⛔ 第一版这里写死过 `在屏上: false`——那是**一句断言**，不是读数。
        文档可见性: document.visibilityState,
        文档有焦点: document.hasFocus(),
        rAF: e1,
        scroll事件: e2,
        UA: navigator.userAgent,
      },
      夹具: { 标题数: 标题数, 源码行数: fx.行数, 填充行: 填充行, 节高: 节高,
              源码侧内容高: 初尺寸.源码侧内容高, 源码侧视口高: 初尺寸.源码侧视口高,
              预览侧内容高: 初尺寸.预览侧内容高, 预览侧视口高: 初尺寸.预览侧视口高,
              常数偏移: 数(常数偏移) },
      检查: 记,
      结论: { 通过: 记.length - 失败 - 跳过, 失败: 失败, 跳过: 跳过,
              总判定: 失败 > 0 ? '失败' : (跳过 > 0 ? '未判定' : '通过') },
    };
  };
})();
