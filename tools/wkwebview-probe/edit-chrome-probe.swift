// rmd · 编辑分栏「外壳」的**离屏视觉闸门**
//
// 起因（2026-10-16 用户）：「滚动条和分割线，搞得小一点，干扰视线。」
// ⚠️ 这一条改的是 `style.css` 的滚动条与 `editor.css` 的焦点态/分界线——
//    **全是浏览器不会报错、`make test-js` 也够不着的东西**（纯 CSS + 伪元素）。
//    按根 `CLAUDE.md` §4，⛔ 不能靠"开个窗口看一眼"来验（抢焦点、打扰用户），
//    ⇒ 用本仓已有的**离屏 WKWebView** 那条路（`cm6-probe.swift` 同族），
//    把"看得见的那一条线有多宽/什么色"变成**可断言的数**。
//
// 它断言什么（逐条见下面 CHECKS 那一串）：
//   ① `color-mix()` 在本机 WKWebView 可用（拇指的半透明从 `--ui-text-muted` 现算）
//   ② `#editor` **不再**自己画右边框（原来与分隔条画成两条相距 2~3px 的灰线）
//   ③ 分隔条**仍然**画着**恰好一条** 1px 的线，且静止时**不是**强调色
//   ④ `.cm-editor.cm-focused` 的焦点态 = 左缘 2px 内阴影，⛔ 不是围住整栏的矩形
//   ⑤ `::-webkit-scrollbar` **真的生效**（判据 = 滚动条**占了 12px 布局宽**）
//   ⭐ ⑥ 光标色**跟着主题走**（2026-10-16 加的第三样，见下面那一段注释）
//   ⭐ ⑦ 顶栏 **Vim 快速开关**：有尺寸、`accent-color` 跟主题、
//       且 `:has(input:checked)` 在本机 WKWebView 上**真的生效**（2026-10-20 用户点题）
//
// ⚠️ ⑤ 那条判据是这份探针存在的核心理由：伪元素的 `getComputedStyle` 拿不到，
//    但"**经典滚动条**要占布局"是它的直接后果 ⇒ 量 `offsetWidth - clientWidth` 即可。
//    ⭐ 它可变异测试：把 `width: 12px` 改掉这个数就变；把整条规则删掉它会回到 15（或 0）。
//
// ⚠️ 页面是**就地拼出来**的，不是加载 `src/index.html`：
//    真页面在**没有 Tauri IPC** 时会走 `reportFatal`，DOM 会被换掉，反而验不到。
//    这里只镜像**编辑态那几件外壳的标记**（`index.html` 的三个容器），
//    ⚠️ 并且**照抄 `index.html` 的样式表顺序**（顺序就是分层，见 `frontend.md`）。
//    CM6 用**产品那一个 bundle**（`src/vendor/cm6.bundle.js`）现场挂，
//    ⛔ 探针不自造 `.cm-editor` 的骨架——否则量的是探针自己写的 CSS。
//
// 用法： edit-chrome-probe <pageDir> [--theme light|dark|warm] [--json] [--png <路径>]
//        ⚠️ `pageDir` 由 `edit-chrome-probe.sh` 现搭：里面是**真**的 `styles/`、`style.css`、
//           `vendor/cm6.bundle.js` 的副本，`index.html` 由本文件写进去。
//           ⛔ 必须走 `loadFileURL` + `allowingReadAccessTo`：
//           `loadHTMLString(_:baseURL:)` 用 file URL 当 base **不会**放行兄弟资源，
//           表现就是"bundle 没加载"（第一版撞在这，白查了一轮）。
// 退出码：0 = 全通过；1 = 有判据失败；2 = 环境自证没过；3 = 跑不起来

import Cocoa
import WebKit

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    FileHandle.standardError.write("用法: edit-chrome-probe <pageDir> [--theme light|dark|warm] [--json] [--png <路径>]\n".data(using: .utf8)!)
    exit(3)
}
let pageDir = argv[1]
var theme = "light"
var asJSON = false
var pngPath: String? = nil
var i = 2
while i < argv.count {
    switch argv[i] {
    case "--theme": theme = (i + 1 < argv.count) ? argv[i + 1] : "light"; i += 2
    case "--json":  asJSON = true; i += 1
    case "--png":   pngPath = (i + 1 < argv.count) ? argv[i + 1] : nil; i += 2
    default:
        FileHandle.standardError.write("未知参数：\(argv[i])\n".data(using: .utf8)!)
        exit(3)
    }
}

let PAGE = """
<!doctype html>
<html lang="zh-CN" data-theme="\(theme)">
<head>
<meta charset="utf-8">
<!-- ⚠️ 顺序**逐行照抄** `src/index.html`（顺序就是分层，⛔ 别调换） -->
<link rel="stylesheet" href="styles/tokens.css">
<link rel="stylesheet" href="styles/themes.css">
<link rel="stylesheet" href="style.css">
<link rel="stylesheet" href="styles/typography.css">
<link rel="stylesheet" href="styles/highlight.css">
<link rel="stylesheet" href="styles/sidebar.css">
<link rel="stylesheet" href="styles/editor.css">
<style>html,body{margin:0;padding:0}</style>
</head>
<body>
  <div class="topbar">
    <div class="toolbar" id="toolbar">
      <button id="btn-edit">编辑</button>
      <!-- ⭐ 2026-10-20（用户点题）：顶栏的 Vim 快速开关——标记**逐字照抄** `index.html`。
           ⚠️ 探针量它两件事：① `accent-color` 跟不跟主题；② `:has()` 在 WKWebView 上
              真的生效吗（不生效时**只有勾选框**会变，整块不变，而浏览器⛔ 不会报错）。 -->
      <label class="toolbar-toggle" title="编辑态按 Vim 键位">
        <input type="checkbox" id="vim-toggle">
        <span>Vim</span>
      </label>
    </div>
    <div id="status" class="status">探针页</div>
    <!-- ⭐ 预览提示条（逐字照抄 `index.html`）——`design/0012` §10.14：
         它必须**住在 `.topbar` 里但不占行**，否则它每显隐一次就把两栏各压矮 23.66px
         （实测，`docs/bugs/0006`）⇒ 打字的时候两栏一起上下抽。 -->
    <div id="preview-bar" class="preview-bar" role="status" hidden>
      <span id="preview-text" class="preview-text"></span>
      <button id="preview-now" class="preview-btn" type="button" hidden>更新预览</button>
    </div>
  </div>

  <!-- 下面三件**逐字照抄** `index.html` 的编辑态外壳（`#editor` / `#editor-splitter` / `#doc`） -->
  <section id="editor" class="editor" aria-label="源码编辑区">
    <div id="edit-bar" class="edit-bar">
      <span id="edit-note" class="edit-note">已进入编辑（探针.md）</span>
      <span id="edit-dirty" class="edit-dirty" hidden>● 未保存</span>
      <span id="edit-status" class="edit-status"></span>
    </div>
    <div id="editor-host" class="editor-host"></div>
  </section>
  <div id="editor-splitter" class="editor-splitter" role="separator" aria-orientation="vertical" title="拖动调整分栏"></div>
  <main id="doc" class="doc" aria-busy="false"></main>

  <!-- ⚠️ 产品那一个 bundle（`make cm6` 产出）——⛔ 探针不自己拼 `.cm-editor` -->
  <script src="vendor/cm6.bundle.js"></script>
</body>
</html>
"""

// ⚠️ 必须 `callAsyncJavaScript`（老 `evaluateJavaScript` 不 await Promise）。
// ⚠️ 让出事件循环一律用 `setTimeout(…, 0)`：本探针窗口 `alphaValue = 0`，
//    WKWebView **不保证**给不可见窗口 rAF ⇒ 等 rAF 会永不回调（`cm6-probe.swift` 的教训）。
let RUNNER = """
  const out = { checks: [], info: {} };
  const M = window.rmdCM6;
  out.info.bundle = !!M;
  if (!M) return out;

  // ── 造一份够长的源码（几百行，保证两栏都真的在滚） ──
  let md = '';
  for (let n = 0; n < 40; n++) {
    md += '# 第 ' + n + ' 节\\n\\n';
    for (let k = 0; k < 6; k++) {
      md += '这是第 ' + n + ' 节第 ' + k + ' 段，用来把源码栏撑到必须滚动的高度。'
          + '中文排版要看的是行高与字号，所以这里写足够多的字。\\n\\n';
    }
    md += '```js\\nconst x = ' + n + ';\\n```\\n\\n';
  }

  const host = document.getElementById('editor-host');
  const view = new M.EditorView({
    state: M.EditorState.create({
      doc: md,
      // ⚠️ 与 `src/editor/main.js::extensions` 同一份清单（白名单就是它）。
      extensions: [M.EditorView.lineWrapping, M.lineNumbers(),
                   M.history(), M.keymap.of(M.historyKeymap), M.markdown()],
    }),
    parent: host,
  });
  view.focus();                       // ⇒ `.cm-editor.cm-focused`
  document.body.classList.add('editing');

  // 预览栏：用真标签，配色交给 `typography.css`
  let ph = '';
  for (let n = 0; n < 40; n++) {
    ph += '<h1>第 ' + n + ' 节</h1>';
    for (let k = 0; k < 6; k++) {
      ph += '<p>这是第 ' + n + ' 节第 ' + k + ' 段，用来把预览栏撑到必须滚动的高度。'
          + '中文排版要看的是行高与字号，所以这里写足够多的字。</p>';
    }
    ph += '<pre><code>const x = ' + n + ';</code></pre>';
  }
  document.getElementById('doc').innerHTML = ph;

  await new Promise(r => setTimeout(r, 0));
  void document.body.offsetHeight;    // 强制布局

  // ── 量 ──
  const cs = (el, pe) => pe ? getComputedStyle(el, pe) : getComputedStyle(el);
  const cmEditor = host.querySelector('.cm-editor');
  const cmScroller = host.querySelector('.cm-scroller');
  const splitter = document.getElementById('editor-splitter');
  const editor = document.getElementById('editor');
  const doc = document.getElementById('doc');

  out.info.focused_by_product = cmEditor ? cmEditor.classList.contains('cm-focused') : null;
  out.info.doc_has_focus = document.hasFocus();
  out.info.active_element = document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null;

  // ── ⚠️⚠️ 焦点态为什么是**手动**加的 ──
  //   离屏窗口**拿不到 DOM 焦点**（实测 `document.hasFocus() === false`，
  //   连 `window.makeKey()` ＋ `makeFirstResponder(webView)` 都不行）——
  //   而 CM6 只在**真焦点**下才挂 `.cm-focused`。⇒ 这里手动加上**CM6 自己用的那个类名**。
  //   ⛔ 这不是伪造被测对象：被测的是 `editor.css` 里那条规则
  //      （`body.editing .editor-host .cm-editor.cm-focused`），而这里给的正是它的触发条件。
  //   ✅ 防自欺：下面**先量"没这个类时"** —— 它必须是 `none`，
  //      否则说明那个阴影/`none` 根本不是这条链给的，后面那条断言就是空的。
  const shadowWithout = cmEditor ? cs(cmEditor).boxShadow : null;
  if (cmEditor) cmEditor.classList.add('cm-focused');
  out.info.focus_shadow = cmEditor ? cs(cmEditor).boxShadow : null;
  out.info.focus_outline = cmEditor ? cs(cmEditor).outlineStyle : null;
  out.info.shadow_without_class = shadowWithout;
  out.info.editor_border_right = cs(editor).borderRightWidth;
  out.info.splitter_bg = cs(splitter).backgroundColor;
  out.info.splitter_line_bg = cs(splitter, '::before').backgroundColor;
  out.info.splitter_line_w = cs(splitter, '::before').width;
  out.info.focus_outline = cmEditor ? cs(cmEditor).outlineStyle : null;
  out.info.focus_shadow = cmEditor ? cs(cmEditor).boxShadow : null;
  out.info.scrollbar_w_editor = cmScroller ? (cmScroller.offsetWidth - cmScroller.clientWidth) : null;
  out.info.scrollbar_w_preview = doc.offsetWidth - doc.clientWidth;
  out.info.editor_scrolls = cmScroller ? (cmScroller.scrollHeight > cmScroller.clientHeight) : null;
  out.info.preview_scrolls = doc.scrollHeight > doc.clientHeight;
  out.info.supports_color_mix = CSS.supports('color', 'color-mix(in srgb, red 40%, transparent)');
  out.info.pane_bg_editor = cmEditor ? cs(cmEditor).backgroundColor : null;
  out.info.pane_bg_preview = cs(doc).backgroundColor;

  // ── 光标色（⭐ 2026-10-16 加的第三样：用户「光标无论在白色主题还是暗色主题下，
  //    光标颜色都是黑色，不合理。光标的颜色应该随主题颜色变动」）──
  // ⛔ 根因**不是"我们没设颜色"**，是 CM6 的 baseTheme 按 `EditorView.darkTheme`
  //    那个 **facet** 二选一（`&light` 黑 / `&dark` 白），而本仓**从不设这个 facet**
  //    ⇒ 它永远停在 `&light` 那一支 ⇒ 三套主题下光标都是黑的。
  const cmContent = host.querySelector('.cm-content');
  out.info.caret_color = cmContent ? cs(cmContent).caretColor : null;
  out.info.text_color = cmEditor ? cs(cmEditor).color : null;
  // ⚠️ `drawSelection()` ⛔ **不在** §2.1① 那张封闭清单里 ⇒ 真页面上 `.cm-cursor`
  //    **根本不存在**（现在起作用的那个光标是**原生 caret**，受 `caret-color` 管）。
  //    ⇒ 这里**造一个** `.cm-cursor`（与上面补 `.cm-focused` 是同一种手法）：
  //    被测的是 `editor.css` 里那条 `… .cm-cursor` 规则，
  //    而 `.cm-cursor` 正是 CM6 自己用的类名（baseTheme 里 `borderLeft: 1.2px solid black`）。
  //    ⚠️ baseTheme 同时给它 `display: none`（上游就写着）——⛔ 不影响取 `border-left-color`。
  //    ✅ 防自欺：这条判据的价值恰恰在于"**没有我们那条规则时**它会读到 baseTheme 的黑"，
  //       ⇒ 它天然可变异（删掉我们的规则就变红），⛔ 不需要另配反向断言。
  const fakeCursor = document.createElement('div');
  fakeCursor.className = 'cm-cursor';
  (cmContent || cmEditor || host).appendChild(fakeCursor);
  out.info.cursor_border = cs(fakeCursor).borderLeftColor;
  out.info.cursor_display = cs(fakeCursor).display;

  // ── ⭐ 2026-10-20：顶栏的 **Vim 快速开关**（用户点题「要在一个显眼的地方，选择打勾，
  //    快速开关」）──
  // ⚠️ 量两件**浏览器不会报错**的事：
  //    ① `accent-color: var(--ui-accent)` 到底解析成什么（⛔ 不是"写了就生效"）；
  //    ② `:has(input:checked)` 在这台 WKWebView 上**真的支持吗**——
  //       不支持时勾选框照样能勾，整块**不变**，页面上一点提示都没有。
  // ⭐ 基线用"临时元素同一个变量"的解析值 ⇒ 判据是**相等**，⛔ 不写死某个色值
  //    （`INV-THEME-02`：探针也不许把三套主题里某一套的值当标准）。
  const vimChk = document.getElementById('vim-toggle');
  const vimWrap = vimChk ? vimChk.closest('.toolbar-toggle') : null;
  const accentProbe = document.createElement('span');
  accentProbe.style.color = 'var(--ui-accent)';
  document.body.appendChild(accentProbe);
  out.info.accent_resolved = cs(accentProbe).color;
  accentProbe.remove();
  out.info.supports_has = CSS.supports('selector(:has(*))');
  out.info.vim_toggle_exists = !!vimWrap && !!vimChk;
  out.info.vim_toggle_accent = vimChk ? cs(vimChk).accentColor : null;
  out.info.vim_toggle_h = vimWrap ? Math.round(vimWrap.getBoundingClientRect().height) : null;
  if (vimWrap && vimChk) {
    out.info.vim_wrap_border_off = cs(vimWrap).borderTopColor;
    vimChk.checked = true;
    void vimWrap.offsetHeight;        // 强制重算样式
    out.info.vim_wrap_border_on = cs(vimWrap).borderTopColor;
    vimChk.checked = false;
  }

  // ── ⭐⭐ 预览提示条（`design/0012` §10.14 / `docs/bugs/0006`）──
  //    用户原话：「在输入状态下，页面会上下晃动，感觉是在滚动。」
  //    ⚠️ 根因之一就在这两行：提示条住在 `.topbar` 里（网格的 `auto` 行）⇒ 它显隐一次，
  //       `auto` 行就长/短一次 ⇒ **两栏一起变矮/变高**。而它每打一阵字要翻两次。
  //    ⇒ 处置 = 留在那层、但 `position: absolute` 钉在下沿（不占行）。
  //
  //  ⭐⭐ **判据已于 2026-10-16 按 `design/0014` §7.3 改写（⛔ 同一条判据换口径，
  //     不是新增一条并存）**：原写「提示条显/隐时两栏**高度差 = 0**」，用户逐字裁定
  //     「原『两栏高度差＝0』可以调整为**实际有效视口的对齐判据**，**不为凑零值扭曲布局**」。
  //     ⇒ 理由：高度差为 0 是**实现手段**，正文可用区域不动才是**产品目标**；
  //        而"高度差 = 0"**结构上抓不到"遮住正文"**——一个 `position:absolute` 的浮层
  //        盖在正文上时，`clientHeight` **一个像素都不变**（那正是裁定 (c) 明令禁止的形态）。
  //     ⇒ 现在的量化对象 = 两栏各自的**有效视口矩形**（右栏 `#doc`、左栏 `.cm-scroller`），
  //        判据是：① 显/隐前后**四条边各自不动**；② 提示条**与两个视口都不相交**。
  const bar = document.getElementById('preview-bar');
  const topbar = document.querySelector('.topbar');

  // ⚠️ 定义「有效视口」= **正文可滚动的那个盒子**：右栏 `#doc`、左栏 `.cm-scroller`。
  //    ⛔ 不是 `#editor` / `#doc` 的 `clientHeight`（那个含边框、也看不见覆盖物）。
  const 圆 = (x) => Math.round(x * 100) / 100;
  const 矩形 = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: 圆(b.top), bottom: 圆(b.bottom), left: 圆(b.left),
             right: 圆(b.right), w: 圆(b.width), h: 圆(b.height) };
  };
  const 取视口 = () => ({ doc: 矩形(doc), ed: 矩形(cmScroller) });
  const 取面板 = () => (bar && !bar.hasAttribute('hidden')) ? 矩形(bar) : null;
  /** 逐边求差（`a - b`），⛔ 逐个字段比，别用一个"总高度差"糊过去。 */
  const 边差 = (a, b) => (a && b) ? {
    top: 圆(a.top - b.top), bottom: 圆(a.bottom - b.bottom),
    left: 圆(a.left - b.left), right: 圆(a.right - b.right),
    w: 圆(a.w - b.w), h: 圆(a.h - b.h),
  } : null;
  const 为零 = (d) => !!d && Object.keys(d).every((k) => d[k] === 0);
  /** 轴对齐矩形是否相交（⛔ 相切不算相交 —— 贴着下沿是允许的，压上去不行）。 */
  const 相交 = (a, b) => !!a && !!b
    && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  if (bar) {
    const t = document.getElementById('preview-text');
    if (t) t.textContent = '预览已过期（正在输入）';
    const b = document.getElementById('preview-now');
    if (b) { b.removeAttribute('hidden'); b.textContent = '更新预览'; }
  }
  bar.setAttribute('hidden', '');
  await new Promise(r => setTimeout(r, 0));
  void document.body.offsetHeight;
  const 藏 = { vp: 取视口(), panel: 取面板(), topbar: topbar.clientHeight };
  bar.removeAttribute('hidden');
  await new Promise(r => setTimeout(r, 0));
  void document.body.offsetHeight;
  const 露 = { vp: 取视口(), panel: 取面板(), topbar: topbar.clientHeight };
  out.info.bar_shown_display = cs(bar).display;
  out.info.bar_position = cs(bar).position;                     // ⛔ 用 `cs` 读，别写死期望
  out.info.bar_in_topbar = (bar.parentElement === topbar);
  out.info.bar_bottom_vs_topbar = 圆(bar.getBoundingClientRect().bottom
      - topbar.getBoundingClientRect().bottom);
  out.info.bar_h = 圆(bar.getBoundingClientRect().height);
  out.info.topbar_h_delta = 藏.topbar - 露.topbar;
  // ⭐ 证据行：视口与面板的**原始矩形**都打出来（判据红了能一眼看出是哪条边动的）
  out.info.vp_hidden = 藏.vp;
  out.info.vp_shown = 露.vp;
  out.info.panel_rect = 露.panel;
  // ⭐⭐ 核心的两个量：① 视口四条边在显/隐前后的差 ② 面板与两个视口是否相交
  out.info.vp_delta_shown_minus_hidden = { doc: 边差(露.vp.doc, 藏.vp.doc), ed: 边差(露.vp.ed, 藏.vp.ed) };
  out.info.panel_overlaps = { doc: 相交(露.panel, 露.vp.doc), ed: 相交(露.panel, 露.vp.ed) };
  out.info.bar_hidden_again_ok = true;
  bar.setAttribute('hidden', '');                                // 还原，免得影响后面取色
  await new Promise(r => setTimeout(r, 0));

  const add = (name, ok, actual, expect) => out.checks.push({ name, ok, actual, expect });

  add('color-mix() 可用（拇指半透明从语义变量现算）',
      out.info.supports_color_mix === true, out.info.supports_color_mix, true);

  add('编辑面挂起来了（`.cm-editor` 存在，否则下面几条量的是 null）',
      cmEditor !== null, cmEditor !== null, true);

  add('⭐ 反向断言：**没** `.cm-focused` 时没有阴影（证明焦点态那两条不是空的）',
      out.info.shadow_without_class === 'none', out.info.shadow_without_class, 'none');

  add('#editor ⛔ 不再自己画右边框（原来与分隔条画成两条灰线）',
      out.info.editor_border_right === '0px', out.info.editor_border_right, '0px');

  add('分隔条背景透明（分界只由那一条线负责，⛔ 不叠一层底色带）',
      out.info.splitter_bg === 'rgba(0, 0, 0, 0)', out.info.splitter_bg, 'rgba(0, 0, 0, 0)');

  add('分隔条**仍然**画着一条线（两栏同色时它是唯一的分界依据）',
      out.info.splitter_line_bg !== 'rgba(0, 0, 0, 0)', out.info.splitter_line_bg, '≠ transparent');

  add('那条线只有 1px',
      out.info.splitter_line_w === '1px', out.info.splitter_line_w, '1px');

  add('⭐ 静止时那条线**不是强调色**（"干扰视线"的直接判据）',
      out.info.splitter_line_bg.indexOf('59, 130, 246') < 0, out.info.splitter_line_bg, '≠ --ui-accent');

  add('焦点态接管了 baseTheme 的点线（⛔ 不许漏出上游写死的深色）',
      out.info.focus_outline === 'none', out.info.focus_outline, 'none');

  add('⭐ 焦点态是**左缘** 2px 内阴影（⛔ 不是围住整栏的矩形）',
      typeof out.info.focus_shadow === 'string'
        && out.info.focus_shadow.indexOf('inset') >= 0
        && out.info.focus_shadow.indexOf('2px 0px 0px 0px') >= 0,
      out.info.focus_shadow, '… 2px 0px 0px 0px inset');

  add('源码栏真的在滚（否则滚动条那两条判据量的是"没有滚动条"）',
      out.info.editor_scrolls === true, out.info.editor_scrolls, true);

  add('预览栏真的在滚', out.info.preview_scrolls === true, out.info.preview_scrolls, true);

  add('⭐ `::-webkit-scrollbar` 生效（判据：滚动条**占了 12px 布局**）— 源码栏',
      out.info.scrollbar_w_editor === 12, out.info.scrollbar_w_editor, 12);

  add('⭐ 同上 — 预览栏', out.info.scrollbar_w_preview === 12, out.info.scrollbar_w_preview, 12);

  add('⭐ 光标色**跟着主题走**（= 它所在那条正文的色，⛔ 不是 baseTheme 写死的那个）',
      out.info.caret_color !== null && out.info.caret_color === out.info.text_color,
      out.info.caret_color, out.info.text_color);

  // ⚠️ 这条的有效前提是 `--ui-text` **不是纯黑**（本仓 light = `--p-gray-900` = `#1a1a1a`，
  //    dark / warm 各一色）。哪天有人把它改成纯黑，这一条会**恒真**（⇒ 不再承重）——
  //    届时改成"逐主题比色值"，⛔ 别删了当没事发生。
  add('⭐ 光标色**不是黑的**（用户原话：「白色主题还是暗色主题下…都是黑色」）',
      typeof out.info.caret_color === 'string' && out.info.caret_color !== 'rgb(0, 0, 0)',
      out.info.caret_color, '≠ rgb(0, 0, 0)');

  add('⭐ 将来装了 `drawSelection()` 也**不会变黑**（`.cm-cursor` 那条路）',
      out.info.cursor_border === out.info.text_color, out.info.cursor_border, out.info.text_color);

  // ── ⭐ 2026-10-20：顶栏 **Vim 快速开关**（用户点题）──
  add('⭐ 顶栏那个 Vim 开关**真的画出来了**（有尺寸、复选框在里面）',
      out.info.vim_toggle_exists === true && typeof out.info.vim_toggle_h === 'number'
        && out.info.vim_toggle_h > 0,
      out.info.vim_toggle_h, '> 0');

  add('⭐ 勾选态的强调色**跟着主题走**（= `--ui-accent` 的解析值，⛔ 不是写死色）',
      out.info.vim_toggle_accent !== null && out.info.vim_toggle_accent === out.info.accent_resolved,
      out.info.vim_toggle_accent, out.info.accent_resolved);

  // ⚠️ 这条是**平台能力**判据，⛔ 不是"用了新语法"的偏好：`:has()` 不支持时
  //    只有那个小方框会变、整块不变，而**浏览器不会报错**（正是这一族探针存在的理由）。
  add('⭐ 勾上时整块边框变强调色（`:has()` 在本机 WKWebView 上真的生效）',
      out.info.supports_has === true && out.info.vim_wrap_border_on === out.info.accent_resolved
        && out.info.vim_wrap_border_on !== out.info.vim_wrap_border_off,
      { supports_has: out.info.supports_has, on: out.info.vim_wrap_border_on,
        off: out.info.vim_wrap_border_off }, out.info.accent_resolved);

  // ── ⭐⭐ 预览提示条：**它一出现就不能动正文的可用区域**（`docs/bugs/0006`
  //    ＋ `design/0014` §7.3 的口径改写）──

  // ⚠️ 前提断言：先证明它真的"露出来了"。⛔ 少了这一条，下面几条可以是"因为根本没显示"而全绿。
  add('前提：提示条在编辑态**真的显示出来了**（否则下面几条是空的）',
      out.info.bar_shown_display === 'flex', out.info.bar_shown_display, 'flex');

  // ⭐⭐ 核心判据①：**显/隐一次，两栏「有效视口」的四条边各自一动不动**。
  //    ⚠️ 这是"打字时页面上下晃"那一条能自动化的形态——用户能感知到的是**正文可用区域**的变化，
  //       ⛔ 不是 CSS 里写了什么。修之前实测：顶栏 +23.66px、两栏各 −23.66px（每阵字翻两次）。
  //    ⭐ 2026-10-16 起量的对象从 `clientHeight` 换成**有效视口矩形**（右栏 `#doc`、
  //       左栏 `.cm-scroller`，逐边 top/bottom/left/right 比）——⛔ 不是"照抄一个 0 值"（§7.3）。
  add('⭐⭐ 提示条显/隐**不动两栏的有效视口**（= 打字时正文可用区域不上下晃）',
      为零(out.info.vp_delta_shown_minus_hidden.doc) && 为零(out.info.vp_delta_shown_minus_hidden.ed),
      JSON.stringify(out.info.vp_delta_shown_minus_hidden),
      '{"doc":{"top":0,"bottom":0,…},"ed":{…}}');

  // ⭐⭐ 核心判据②（⭐ 这一条是**老口径结构上抓不到**的那一半）：提示条**不许与正文相交**。
  //    ⚠️ 一个 `position: absolute` 的浮层盖在正文上时，上面那条判据**照样全绿**
  //       （`clientHeight` 一个像素都不变）——而那正是裁定 (c) 点名的"遮住正文"。
  add('⭐⭐ 提示条**不与任何一栏的正文相交**（⛔ 不许浮在正文上盖住字）',
      out.info.panel_overlaps.doc === false && out.info.panel_overlaps.ed === false,
      JSON.stringify(out.info.panel_overlaps), '{"doc":false,"ed":false}');

  // ⭐ 而且**顶栏自己的高度也不许变**（它是网格的 `auto` 行，变它就是变两栏）。
  add('⭐ 顶栏自己的高度也不变（`auto` 行没被撑开）',
      out.info.topbar_h_delta === 0, out.info.topbar_h_delta, 0);

  // ⚠️ 住址不许挪：它必须**仍在 `.topbar` 里**（`editor.css` 的注释写着为什么），
  //    只是不占行——判据是"贴着顶栏下沿"（相差 ≤ 1px）而不是"在某一栏里"。
  add('⭐ 提示条**仍在 `.topbar` 内部**且贴它的下沿（⛔ 没被挪去浮在正文上）',
      out.info.bar_in_topbar === true && Math.abs(out.info.bar_bottom_vs_topbar) <= 1,
      out.info.bar_in_topbar + ' / ' + out.info.bar_bottom_vs_topbar + 'px', 'true / ≈0px');

  // ⚠️ ⛔ **这一条是"当前那条实现手段"，⛔ 不是目标**（`design/0014` §7.3：⛔ 不为凑零值扭曲布局）。
  //    留着它是为了在**手段被换掉**时响亮一次（换手段本身没问题，但那时要重看上面两条
  //    是不是还有别的理由成立）。⇒ 它红了，先问"新的手段还能不能过上面两条"，⛔ 别直接改判据。
  add('⭐ 它是**绝对定位**（当前那条"不占行"的手段；⚠️ 换手段不算违规，但要重看上面两条）',
      out.info.bar_position === 'absolute', out.info.bar_position, 'absolute');

  return out;
"""

private final class Delegate: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.callAsyncJavaScript(RUNNER, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .failure(let error):
                FileHandle.standardError.write("⛔ callAsyncJavaScript 失败：\(error)\n".data(using: .utf8)!)
                exit(1)
            case .success(let value):
                guard let obj = value as? [String: Any],
                      let checks = obj["checks"] as? [[String: Any]] else {
                    FileHandle.standardError.write("⛔ 返回值不是预期形状：\(String(describing: value))\n".data(using: .utf8)!)
                    exit(1)
                }
                let info = (obj["info"] as? [String: Any]) ?? [:]

                if let png = pngPath {
                    let cfg = WKSnapshotConfiguration()
                    cfg.afterScreenUpdates = false
                    webView.takeSnapshot(with: cfg) { image, err in
                        if let image = image,
                           let tiff = image.tiffRepresentation,
                           let rep = NSBitmapImageRep(data: tiff),
                           let data = rep.representation(using: .png, properties: [:]) {
                            try? data.write(to: URL(fileURLWithPath: png))
                            FileHandle.standardError.write("· 快照 → \(png)\n".data(using: .utf8)!)
                        } else {
                            FileHandle.standardError.write("⚠️ 快照拿不到（\(err.map(String.init(describing:)) ?? "无图")）——判据不受影响\n".data(using: .utf8)!)
                        }
                        emit(checks: checks, info: info)
                    }
                    return
                }
                emit(checks: checks, info: info)
            }
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("⛔ 导航失败：\(error)\n".data(using: .utf8)!); exit(3)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("⛔ 预导航失败：\(error)\n".data(using: .utf8)!); exit(3)
    }
}

func emit(checks: [[String: Any]], info: [String: Any]) {
    if asJSON {
        let payload: [String: Any] = ["theme": theme, "info": info, "checks": checks]
        if let d = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .prettyPrinted]),
           let s = String(data: d, encoding: .utf8) { print(s) }
        exit(checks.allSatisfy { ($0["ok"] as? Bool) == true } ? 0 : 1)
    }
    // 环境自证：bundle 不在 ⇒ 下面每一条都量不到东西，**响亮地**退 2（⛔ 不静默降级）
    if (info["bundle"] as? Bool) != true {
        FileHandle.standardError.write("⛔ `window.rmdCM6` 不在——先跑 `make cm6`（`src/vendor/cm6.bundle.js` 是产物）\n".data(using: .utf8)!)
        exit(2)
    }
    print("# 编辑分栏外壳闸门（theme=\(theme)）")
    var bad = 0
    for (n, c) in checks.enumerated() {
        let ok = (c["ok"] as? Bool) == true
        if !ok { bad += 1 }
        print("\(ok ? "ok" : "not ok") \(n + 1) - \(c["name"] as? String ?? "?")")
        print("#    实测 = \(c["actual"] as? String ?? String(describing: c["actual"] ?? "nil"))"
              + "   期望 = \(c["expect"] as? String ?? String(describing: c["expect"] ?? "nil"))")
    }
    print("# 实测量：")
    for k in info.keys.sorted() { print("#    \(k) = \(info[k]!)") }
    print(bad == 0 ? "1..\(checks.count)  ✅ 全通过" : "⛔ \(bad)/\(checks.count) 条失败")
    exit(bad == 0 ? 0 : 1)
}

let app = NSApplication.shared
// ⚠️⚠️ **`.prohibited`，⛔ 不是 `.accessory`**（`kb/0025` ＋ 2026-10-21 判别器实测）：
//    `.accessory` 只是"没有 Dock 图标"，**仍然可以被激活**——从**正在前台的终端**里起进程时，
//    AppKit 会把本进程激活（实测 `frontmostApplication` 由 `iTerm2` 变成探针自己）。
//    `.prohibited` 是唯一"结构上不允许被激活"的档位，**且实测不损 rAF**：
//    同样 `alphaValue = 0` ＋ `orderBack`，两种策略各量到 **63 帧 / 1000 ms**，
//    而 `.prohibited` 前后 `frontmostApplication` 不变、`NSApp.isActive == false`。
_ = app.setActivationPolicy(.prohibited)

let config = WKWebViewConfiguration()
config.suppressesIncrementalRendering = false
let rect = NSRect(x: 0, y: 0, width: 1400, height: 900)
let webView = WKWebView(frame: rect, configuration: config)
private let delegate = Delegate()
webView.navigationDelegate = delegate

let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
// ⚠️ `alphaValue = 0` = **离屏**（根 `CLAUDE.md` §4 的 ✅ 那一侧）。
// ⛔ 不用 `set frontmost` / `AXRaise` / 合成按键——那些会动用户的前台窗口。
window.alphaValue = 0

DispatchQueue.main.async {
    let base = URL(fileURLWithPath: pageDir)
    let htmlURL = base.appendingPathComponent("index.html")
    do {
        try PAGE.write(to: htmlURL, atomically: true, encoding: .utf8)
    } catch {
        FileHandle.standardError.write("⛔ 写不出 \(htmlURL.path)：\(error)\n".data(using: .utf8)!)
        exit(3)
    }
    // ⚠️ **`orderBack` 是必须的**：只 `alphaValue = 0` 而从不 order 的窗口，WebKit 当它
    //    完全不可见 ⇒ **一帧 rAF 都不派**（`kb/0022`；本文件第一版就撞在这）。
    // ⛔ **`makeKey()` / `makeFirstResponder` 已删**（2026-10-21 实测）：`.prohibited` 策略下
    //    `isKeyWindow` 恒为 false，而 26 条判据（含「焦点态」那两条）**照样全绿** ⇒
    //    它对 `view.focus()` / `.cm-focused` 也不是必要条件。删掉 = 少写一次系统状态。
    //    那两条现在靠页面侧**手动补 `.cm-focused`**（见文件上半段的反向断言）。
    // ⛔ 绝不做 `set frontmost` / `AXRaise` / 合成按键（根 `CLAUDE.md` §4）。
    window.orderBack(nil)
    FileHandle.standardError.write("▶ 加载 \(htmlURL.path)（theme=\(theme)）\n".data(using: .utf8)!)
    webView.loadFileURL(htmlURL, allowingReadAccessTo: base)
}

// 兜底超时（macOS 没有 coreutils 的 `timeout`）
let wall = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + 60) {
    if Date().timeIntervalSince(wall) >= 59.5 {
        FileHandle.standardError.write("⛔ 60 秒没拿到结果\n".data(using: .utf8)!); exit(3)
    }
}
app.run()
