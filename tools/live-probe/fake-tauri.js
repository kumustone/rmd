// ⭐ `design/0047` §7.2 第 6 条（`make probe-live-block`）的**假后端**。
//
// 目的：让**真应用**（真 `src/index.html` ＋ 真 `src/main.js` ＋ 真 `src/live/**`）
// 在一个**离屏页面**里跑起来，从而驱动真的 `onLiveDocDown` / `makeLiveView` / `swapLiveView`。
// ⛔ 探针**不重写**那三份实现——重写就是第二份实现（`INV-SINGLE-01` 的探针版）。
//
// ⚠️⚠️ **它不渲染 Markdown**：`render_preview` 回的是 Stage A 用**真 comrak**
//    （`commands/document.rs::render_source`）导出的那一份 HTML 原件。
//    ⇒ 因此本探针**只在"未真正改动正文"的路径上跑**（进入 / 组合 / 撤销后退出）：
//    一旦真的提交了改动，假渲染给出的 html 与文本就对不上，那是**探针的**限制，
//    ⛔ 不是产品的行为。需要"改字后整篇重渲"的判据分给：
//      · `make probe-live-commit`（提交无损，逐字符）
//      · `make fidelity`（Rust 侧打开→改字→写盘逐字节）
//      · 人验（可见首帧，§7.1 0c-②）
//    ⭐ **唯一例外是 `line_count`**（2026-10-28，`bugs/0024`）：它是**文本的纯函数**，
//    不回它则凡改行数的提交都会被 `acceptReply` 拒（`⌘↵` 新起一段那三行永远验不到）。
//    它**不改变**上面那条边界：html / blocks 仍是原件，W 段因此只比 IPC 载荷与宿主位置。
//
// ⚠️ `window.__IPC` 记下每一次调用（含参数）：harness 用它判"到底调过哪些命令"，
//    ⛔ 不靠"界面看起来对"推断。
(function () {
  'use strict';

  const D = window.__FIXTURE;
  if (!D || !D.name) {
    window.__FAKE = { 致命: '夹具没注入（window.__FIXTURE 缺失）' };
    return;
  }
  const PATH = '/probe/' + D.name + '.md';
  const calls = [];
  const counts = Object.create(null);
  window.__IPC = calls;
  window.__UNKNOWN = [];

  /**
   * ⭐ **按竖线切一行表格的格子内容区间**（两侧 ASCII 空白修剪，0-based 左闭右开）。
   *
   * 这是对后端 `blocks.rs::cell_span` 的**仿写**，只为了在"提交之后"重算列区间：
   * 真后端每次 `render_preview` 都会拿**新的文本**重新 parse、重新算一遍区间
   * （`commands/edit.rs` 与 `commands/document.rs` 同口径）；假后端不解析 Markdown，
   * 只会把 Stage A 那份原件再回一遍 ⇒ **改过一格之后，同一行后面那些格子的列区间就全错位**，
   * 下一次进格读到的就是隔壁的字节（2026-10-28 实测：`Q12` 里"格首 ⌫"一个字节都没删，
   * 提交出去的全文却变了——那是**探针**的错位，⛔ 不是产品的）。
   *
   * ⚠️ 只认反斜杠转义（`\|`，与 `INV-CELL-02` 的写回口径一致）；"行内代码里的竖线"
   *    本项目五份夹具里没有 ⇒ 真出现时**切出来的格数会对不上**，调用方会**原样保留旧区间**
   *    （宁可不改：⛔ 别让测试替身替产品擦屁股）。
   * ⚠️ UTF-16 码元口径**天然对**：JS 字符串下标就是 UTF-16 码元，与后端换算后的口径同源。
   * ⭐⚠️ **首尾竖线可以省**（`bugs/0038`）：GFM 允许写成 `a | b`，第一格在行首、
   *    最后一格在行尾。旧版只在**看到第一根竖线之后**才开始收格子 ⇒ `a | b` 只切出一格，
   *    格数对不上就整行保留旧区间（→ 提交后同一行后面的格全错位）。现在按"未转义竖线
   *    切段"来切，两侧由段边界自己封口。（产品侧的可写判据是**相邻关系**而非竖线位置，
   *    与这里的分段互不影响。）
   */
  function 切格(行, 应数) {
    const s = String(行 === undefined || 行 === null ? '' : 行);
    const out = [];
    function 收(a, b) {
      while (a < b && (s.charAt(a) === ' ' || s.charAt(a) === '\t')) a++;
      while (b > a && (s.charAt(b - 1) === ' ' || s.charAt(b - 1) === '\t')) b--;
      out.push([a, b]);
    }
    let 起 = 0;
    let 首段 = true;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (ch === '\\') { i++; continue; }
      if (ch !== '|') continue;
      // ⚠️ 行首那根竖线只是**边框**，它前面没有格子；中间的连续竖线之间是**真空格子**。
      if (起 < i || !首段) 收(起, i);
      起 = i + 1;
      首段 = false;
    }
    if (起 < s.length || !首段) 收(起, s.length);
    // ⚠️ 收尾那根竖线之后会多出一个**空**片段（`| a | b |` ⇒ 三段），而后端只认
    //    真正的 `TableCell` ⇒ 把末尾的空段削到与载荷里的格数一致。
    while (out.length > 应数 && out[out.length - 1][0] === out[out.length - 1][1]) out.pop();
    return out;
  }

  /** 拿 Stage A 的区间表（决定"哪些行、每行几格"）＋ 新文本，重算列。格数对不上就保留旧的。 */
  function 重算格子(text) {
    const src = D.table_cells;
    if (!src || !src.length || typeof text !== 'string') return src || [];
    const 行们 = text.split('\n');
    return src.map(function (entry) {
      const spans = entry[1] || [];
      const 每行 = Object.create(null);
      for (let i = 0; i < spans.length; i++) {
        const ln = spans[i][0];
        (每行[ln] || (每行[ln] = [])).push(spans[i]);
      }
      const out = [];
      for (let i = 0; i < spans.length; i++) {
        const sp = spans[i];
        const 组 = 每行[sp[0]] || [sp];
        const 切 = 切格(行们[sp[0] - 1], 组.length);
        const k = 组.indexOf(sp);
        if (切.length === 组.length && 切[k]) out.push([sp[0], 切[k][0], 切[k][1], sp[3]]);
        else out.push([sp[0], sp[1], sp[2], sp[3]]);
      }
      return [entry[0], out];
    });
  }

  /**
   * ⭐ **候选校验的探针侧仿写**（`design/0054` `INV-EDITOBJ-03`）—— `render_preview` 带
   * `verify` 时的那一份判决。
   *
   * 真实现是 `document/blocks.rs::verify_cell_edit`（**同一份 comrak**、同一份 `cell_span`）。
   * 假后端不解析 Markdown ⇒ 这里只做两件真实现也做的事：
   *   ① 用 **Stage A 的区间表 ＋ `切格`** 在基线与候选上各算一遍形状；
   *   ② 判「候选是不是**按基线把一个格区间换掉**得到的」，再逐格比对。
   * ⚠️ **`reason` 串与真实现逐字同源**（`baseline_parse` / `line_mismatch` / `not_writable` /
   *    `newline` / `candidate_mismatch` / `table_changed` / `neighbor_changed` / `cell_content`）
   *    ——前端只把理由翻成人话，⛔ 这里不许造新理由。
   * ⚠️⚠️ **缺了它，所有单元格提交都会被判 `verify-missing`**（前端：没有回包就不许发布），
   *    而屏幕上看起来只是"提交没生效"——与产品真有 bug 同形。2026-10-28 补。
   */
  function 形状(text, block) {
    const src = D.table_cells;
    if (!src || !src.length) return null;
    let entry = null;
    for (let i = 0; i < src.length; i++) {
      if (src[i][0] === block) { entry = src[i]; break; }
    }
    if (!entry) return null;
    const 行们 = String(text === undefined || text === null ? '' : text).split('\n');
    const spans = entry[1] || [];
    const 组 = Object.create(null);
    const 顺序 = [];
    for (let i = 0; i < spans.length; i++) {
      const ln = spans[i][0];
      if (!组[ln]) { 组[ln] = []; 顺序.push(ln); }
      组[ln].push(spans[i]);
    }
    顺序.sort(function (x, y) { return x - y; });
    const cells = [];
    const rowSizes = [];
    for (let k = 0; k < 顺序.length; k++) {
      const ln = 顺序[k];
      const g = 组[ln];
      rowSizes.push(g.length);
      const 切 = 切格(行们[ln - 1], g.length);
      for (let i = 0; i < g.length; i++) {
        const sp = g[i];
        // ⚠️ 格数对不上时**原样保留旧区间**（与 `重算格子` 同一条纪律：⛔ 不替产品猜）。
        if (切.length === g.length && 切[i]) cells.push([ln, 切[i][0], 切[i][1], sp[3]]);
        else cells.push([ln, sp[1], sp[2], sp[3]]);
      }
    }
    return { cells: cells, rowSizes: rowSizes };
  }

  /** 第 `i` 格在这一行里的原文（区间是**修剪后**的，所以这里不再 trim）。 */
  function 格文本(行们, cell) {
    return String(行们[cell[0] - 1] || '').slice(cell[1], cell[2]);
  }

  function 校验候选(req, candidate) {
    function 否(reason, detail) {
      return { ok: false, reason: reason, detail: detail };
    }
    if (!req || typeof req.baseline !== 'string' || typeof candidate !== 'string') {
      return 否('baseline_parse', '校验请求缺 baseline 或候选');
    }
    const 基 = 形状(req.baseline, req.block);
    if (!基) return 否('baseline_parse', '基线里没有第 ' + req.block + ' 块表格');
    const target = 基.cells[req.cell];
    if (!target) {
      return 否('baseline_parse', '基线第 ' + req.block + ' 块只有 ' + 基.cells.length + ' 格');
    }
    if (target[0] !== req.line) {
      return 否('line_mismatch', '基线里这一格在第 ' + target[0] + ' 行，请求说第 ' + req.line + ' 行');
    }
    if (!target[3]) return 否('not_writable', '这一格在基线里就不可写');
    const rep = String(req.replacement === undefined || req.replacement === null ? '' : req.replacement);
    if (rep.indexOf('\n') >= 0 || rep.indexOf('\r') >= 0) return 否('newline', '替换源码含换行');

    // ① 后端自己造出**唯一合法候选**，再与送来的候选逐字比。
    const 基线行 = req.baseline.split('\n');
    const 该行 = String(基线行[target[0] - 1] || '');
    const 应 = 基线行.slice();
    应[target[0] - 1] = 该行.slice(0, target[1]) + rep + 该行.slice(target[2]);
    if (candidate !== 应.join('\n')) {
      return 否('candidate_mismatch', '送来的候选与按基线＋替换算出来的不是同一份');
    }

    // ② 在候选上重新算形状，逐格比对。
    const 候 = 形状(candidate, req.block);
    if (!候) return 否('table_changed', '候选里第 ' + req.block + ' 块不再是表格');
    if (候.rowSizes.join(',') !== 基.rowSizes.join(',')) {
      return 否('table_changed', '每行格数变了：基线 ' + 基.rowSizes.join(',')
        + ' → 候选 ' + 候.rowSizes.join(','));
    }
    const 候行 = candidate.split('\n');
    for (let i = 0; i < 基.cells.length; i++) {
      const b = 基.cells[i];
      const c = 候.cells[i];
      if (!c) return 否('table_changed', '候选里第 ' + i + ' 格不见了');
      if (c[3] !== b[3]) {
        return 否(i === req.cell ? 'table_changed' : 'neighbor_changed',
          '第 ' + i + ' 格的「真实 vs 自动补格」状态变了');
      }
      const ctext = 格文本(候行, c);
      if (i === req.cell) {
        // ⚠️ 两侧修剪：区间定义**就是**"两侧 ASCII 空白之外的那一段"。
        if (ctext.trim() !== rep.trim()) return 否('cell_content', '目标格写进去的是「' + ctext + '」');
      } else if (ctext !== 格文本(基线行, b)) {
        return 否('neighbor_changed', '第 ' + i + ' 格的内容变了');
      }
    }
    return { ok: true, reason: '', detail: '' };
  }

  /** 与后端 `DocumentPayload` 同形。⚠️ `t1_ms..t3_ms` 必须是数字（`mountDocument` 会 `.toFixed(1)`）。 */
  function docPayload(gen, req, text) {
    return {
      gen: gen,
      req: req,
      path: PATH,
      real_path: PATH,
      doc_dir: '/probe',
      html: D.html,
      toc: D.toc || [],
      line_count: D.line_count,
      block_kinds: D.block_kinds,
      blocks: D.blocks,
      // ⭐ `design/0049`：单元格区间（Stage A 用 `blocks::cells_to_wire` 导出）。
      //    ⚠️ 缺了它产品会走 `status.cell-unavailable` —— 与"后端没实现对"同形。
      //    ⭐⭐ 2026-10-28：**有文本时按文本重算列**（见 `切格` / `重算格子` 的注释）——
      //    真后端每次预览都会重算，替身不重算就会让"第二次编辑"在**错位的列**上被判。
      table_cells: 重算格子(text),
      // ⭐ `design/0051`：任务项方框区间（`blocks::tasks_to_wire`）。
      //    ⚠️ 同上：缺了它点方框只会说「这一页没有任务项的位置信息」，
      //    那与「后端没导出」在探针里**同形** ⇒ V 段会整段判红而看不出原因。
      task_items: D.task_items || [],
      outside_roots: false,
      roots_nonempty: false,
      t1_ms: 0.1, t2_ms: 0.1, t3_ms: 0.1, t_blocks_ms: 0.1,
      source_bytes: D.text.length,
      html_bytes: D.html.length,
      ast_nodes: 1,
      toc_entries: (D.toc || []).length,
      had_bom: false,
      code_highlighted: 0,
      code_unhighlighted: 0,
      doc_seq: 1,
    };
  }

  // ⭐ 单文件模式 ＋ 启动文档 = 夹具 ⇒ `bootInner` 第 4 步会走 `openDocument`，
  //    于是 `mountDocument` 跑一遍、`noteLive` 对齐一次——正是我们要的启动形态。
  // ⭐ `live_edit: true` 是**唯一**把整条能力接上的开关（§8），写在快照里（snake_case）。
  const snapshot = {
    generation: 1,
    roots: [],
    files: [],
    mode: 'single-file',
    pending_directory: null,
    sidebar_width: 260,
    appearance: {
      mode: 'light', font_size: 14, line_height: 1.7, content_width: 0, vim_mode: false,
    },
    last_directory: null,
    startup_document: PATH,
    doc_seq: 1,
    reading_progress: {},
    dir_session: null,
    recent: [],
    favorites: [],
    language: 'zh',
    language_preference: 'zh',
    sidebar_file_view: 'tree',
    hide_empty_dirs: true,
    live_edit: true,
  };

  /**
   * 命令表。⚠️ 只列**这条路径上真会用到**的那些 ＋ 启动路径上的闲聊命令；
   * 未列出的命令**不静默**：记进 `window.__UNKNOWN` 并回 `null`，
   * 由 harness 在收尾时判"有没有未预期的命令"。
   */
  const table = {
    get_session: function () { return snapshot; },
    // ⭐ **真的**键位表：Stage A 从 `gui::SHORTCUTS` 导出、由 `block-probe.sh` 注进每份夹具。
    //    ⚠️ 别改回空表：`0h` 的纵向链路按 `⌘S`，空表 ⇒ 匹配器认不出任何键
    //    ⇒ "按了没反应"与"产品没接线"输出一模一样（那次 0h 就等于没验）。
    get_shortcuts: function () { return D.shortcuts || []; },
    take_pending_open: function () { return []; },

    open_document: function (a) { return docPayload(a.generation, a.req); },
    // ⚠️ 假渲染：html 恒为原件。见文件头"它不渲染 Markdown"。
    // ⭐ **例外：`line_count` 如实回**（2026-10-28，`bugs/0024`）。它是**文本的纯函数**
    //    （后端 `LineIndex::line_count()` ＝ `split('\n').length`，见 `document/offset.rs`），
    //    ⛔ 不是"渲染 Markdown"。不回它的话，凡**改了行数**的提交都会被
    //    `model.acceptReply` 判成"行号已陈旧"（`line_count 不符`）⇒ `⌘↵` 新起一段那三行
    //    在探针里**根本走不到**（产品其实完全正常）。⚠️ `html` / `blocks` 仍是原件——
    //    所以 W 段的判据一律不碰渲染态 DOM 的内容，只比 IPC 载荷与宿主位置。
    render_preview: function (a) {
      const 文本 = a && typeof a.text === 'string' ? a.text : null;
      const p = docPayload(a.generation, a.req, 文本);
      if (文本 !== null) p.line_count = 文本.split('\n').length;
      // ⭐ `design/0054` `INV-EDITOBJ-03`：带 `verify` 请求时**如实判决并回显 token**。
      //    ⚠️⚠️ 缺这一段 ⇒ 前端读到"这份候选没被验过" ⇒ 每次单元格提交都被拒
      //    （`verify-missing`），而屏幕上只是"提交没生效"，与产品真有 bug 同形。
      //    ⚠️ 校验失败**也照样回渲染载荷**（真后端同口径：不为失败路径开只解析的分叉）。
      const v = a && a.verify;
      if (v && typeof v === 'object') {
        const 判 = 校验候选(v, 文本);
        p.verify = {
          token: String(v.token === undefined || v.token === null ? '' : v.token),
          ok: 判.ok === true,
          reason: 判.reason || '',
          detail: 判.detail || '',
          ms: 0,
        };
      }
      return p;
    },

    begin_edit: function () {
      return {
        real_path: PATH,
        text: D.text,
        // ⭐ 三键：`bom` / `eol` / `lossy`（`Envelope` 的 Serialize 实现）。
        envelope: { bom: false, eol: 'lf', lossy: false },
      };
    },
    end_edit: function () { return null; },
    // ⚠️⚠️ **必须把 `text` 记回 `D.text`**（2026-10-27，`bugs/0018` 的 P 段第一次跑就撞上）：
    //    真后端写盘之后，磁盘上的那一份**就是**刚写的这一份；假后端不记，`begin_edit`
    //    就永远回**最初**那份原文，而会话里的 `baseline` 在保存成功之后**已经前进**了
    //    ⇒ 之后每一次进入都判「正文在打开后被改过（磁盘上的内容已经变了）」，
    //      而**产品其实完全正常**——那是探针自己造出来的假红。
    //    ⛔ 别用 `written: 0` 当作"什么都没发生"：这里改的是**磁盘内容**，不是"写了几次"。
    //    ⚠️ 只记 `text`，⛔ `html` / `blocks` / `line_count` 仍是原件——本探针不渲染 Markdown。
    save_document: function (a) {
      if (a && typeof a.text === 'string') D.text = a.text;
      return { written: 1, bytes: D.text.length, ms: 0 };
    },

    watch_document: function () { return { seq: 1, path: PATH }; },
    unwatch_document: function () { return null; },

    set_reading_progress: function () { return { status: 'ok' }; },
    set_appearance: function () { return null; },
    set_sidebar_width: function () { return null; },
    set_sidebar_file_view: function () { return null; },
    set_language: function () { return null; },
    set_dir_session: function () { return { status: 'ok', entry: null, evicted: 0 }; },
    recent_apply: function () { return null; },
    favorites_apply: function () { return null; },

    read_asset: function () { return null; },
    list_dir: function (a) { return { gen: a.generation, req: a.req, entries: [] }; },
    list_documents: function (a) {
      return { gen: a.generation, req: a.req, items: [], total: 0, truncated: false };
    },
    search_files: function (a) { return { gen: a.generation, req: a.req, hits: [] }; },
    open_link: function () { return null; },
    open_in_external_editor: function () { return null; },
    report_status: function () { return null; },
    report_measure: function () { return null; },
  };

  // ⭐ `切格` 也给 harness 用（`Q` 段要判"这一格在第几个"，同一行里 `单元格` 出现三次，
  //    `indexOf` 恒取第一处 ⇒ 判据会判到**隔壁格**上去）。⇒ 只有一份实现，⛔ 不各写一遍。
  window.__FAKE = { path: PATH, counts: counts, snapshot: snapshot, fixture: D, 切格: 切格 };

  window.__TAURI__ = {
    core: {
      invoke: async function (cmd, args) {
        calls.push({ cmd: cmd, args: args || {} });
        counts[cmd] = (counts[cmd] || 0) + 1;
        const f = table[cmd];
        if (typeof f !== 'function') {
          window.__UNKNOWN.push(cmd);
          return null;
        }
        return f(args || {});
      },
    },
    // ⚠️ 只有形状要求：`listen` 必须返回一个退订函数（`tauri.js::listen` 直接透传）。
    event: {
      listen: async function () { return function () {}; },
    },
  };

  // ⭐ 初始语言由后端注入（`gui/mod.rs::init_script`）——探针照抄这一步。
  window.__rmdLang = 'zh';
})();
