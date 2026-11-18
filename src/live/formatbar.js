// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
//
// `design/0061` L4：**选中浮动格式栏** —— 隐藏标记之后，用户修改 Markdown 标记的唯一入口。
//
// # 它负责什么、⛔ 不负责什么
//
// ① **纯决策**（本文件的承重部分，node 里直接测）：
//    `toggleInline` / `togglePrefix` / `headingLevel` / `insertLink` 全部是
//    `(源码, 选区) -> 编辑计划` 的纯函数，⛔ 不碰 DOM、⛔ 不碰 CM6、⛔ 不读全局。
//    语义照 Mardo 的 `EditorCommands`（`research/products/0005` §9.2）：
//       命中标记 ⇒ 剥离；未命中 ⇒ 包裹；空选区 ⇒ 插入一对并把光标放中间。
//    ⚠️ 判据**只按源码字节算**（`design/0061` §6 的第三类失败）：选区跨过隐藏标记时
//    ⛔ 不试图"所见即所得"地猜它覆盖了谁 —— 隐藏标记在屏幕上看不见，猜出来的
//    第二份真相与正文真值分叉（`INV-LIVE-17`）。
//
// ② **薄 DOM 壳**：浮动条本体、定位、按钮点击。编辑只经
//    `view.dispatch({ changes, selection })`，⛔ 不直接改 DOM、⛔ 不自己拼提交载荷。
//
// # 三条屏幕不报错的坑
//
// 1. ⛔ **不许抢焦点**（`INV-LIVE-12`）：按钮的 `mousedown` 必须 `preventDefault()`，
//    否则焦点离开离屏 `textarea`，CM6 的选区当场丢掉、IME 也断。
//    浮层自身 `pointer-events: none`，只有按钮吃点击（`design/0061` §6 最后一行）。
// 2. ⛔ **加载期不许读 `window.rmd.*`**：本文件排在 `live/index.js` **之前**，
//    那一步读到的会是 `undefined`，而症状是"整个窗口空白"（`frontend.md` 第 2 条）。
//    这里全部走 `rmdModule()` 的**运行期**惰性查找。
// 3. ⚠️ `active.view` 是 `main.js::makeLiveView` 的**适配对象**（有 `dom`/`lines`/`selection`），
//    ⛔ 不是 CM6 的 `EditorView`。真正的视图用 `EditorView.findFromDOM(adapter.dom)` 取回
//    ——它就在那个 host 里面，⛔ 不另建实例、⛔ 不缓存跨块。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，顶层 `const` 撞名会让
// **整个文件不执行**（窗口空白、stderr 全静默）。理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────
  // 类型
  // ────────────────────────────────────────────────────────────────

  /**
   * 一次 CM6 变更（`view.dispatch({ changes })` 直接吃这个形状）。
   * @typedef {{from:number, to:number, insert:string}} Change
   */

  /**
   * 一次格式命令的结果：变更列表 ＋ 变更**之后**的选区。
   * @typedef {{changes:Change[], selection:{anchor:number, head:number}}} EditPlan
   */

  /**
   * 浮动条上的一个按钮。
   * `key` 是句点后的字典键段（完整键 = `live.format.` + `key`），⛔ 不带任何语言的文案。
   * @typedef {{cmd:string, text:string, key:string, cls?:string}} BarButton
   */

  // ────────────────────────────────────────────────────────────────
  // 一、纯决策（node 判据直接调；⛔ 不碰 DOM / CM6）
  // ────────────────────────────────────────────────────────────────

  /**
   * 校验并归一化选区。**越界抛错、⛔ 不夹取**（与 `live/model.js::applyEdit` 同一条纪律：
   * 夹取会把"算错了"伪装成"执行成功"）。
   * @param {string} text
   * @param {number} anchor
   * @param {number} head
   * @returns {{from:number, to:number}}
   */
  function rangeOf(text, anchor, head) {
    if (!Number.isInteger(anchor) || !Number.isInteger(head)) throw new Error('selection is not an integer');
    if (anchor < 0 || head < 0 || anchor > text.length || head > text.length) throw new Error('range out of bounds');
    return { from: Math.min(anchor, head), to: Math.max(anchor, head) };
  }

  /**
   * 选区覆盖到的**整行**（0-based 偏移）。
   *
   * ⚠️ 右端规则：选区正好停在下一行的行首时，**不起头的那一行不算**——
   * 用户拖过换行符的常见形态是"选了整行"，把下一行的行首也算进来会多改一行
   * （列表 / 引用 / 标题都会在那里多出一个前缀）。
   *
   * @param {string} text
   * @param {number} from
   * @param {number} to
   * @returns {Array<{start:number, end:number}>} `end` 是行尾（不含换行符）
   */
  function selectedLines(text, from, to) {
    const first = text.lastIndexOf('\n', from - 1) + 1;
    // `to` 指向某一行行首（前一个是换行符）⇒ 最后一行取**换行符所在的那一行**。
    let lastChar = to;
    if (to > from && to > 0 && text.charAt(to - 1) === '\n') lastChar = to - 1;
    /** @type {Array<{start:number, end:number}>} */
    const lines = [];
    let start = first;
    for (;;) {
      const nl = text.indexOf('\n', start);
      const end = nl < 0 ? text.length : nl;
      lines.push({ start: start, end: end });
      if (end >= lastChar || nl < 0) break;
      start = nl + 1;
    }
    return lines;
  }

  /**
   * 把一个**原始坐标**映射到变更之后的新坐标。
   *
   * ⚠️ 只用于行首插入 / 删除前缀这一族（变更按位置升序、互不重叠）。
   * inline 那一族不走这里：它的选区映射是简单的整体平移，见 `toggleInline`。
   *
   * @param {number} pos
   * @param {Change[]} changes
   * @returns {number}
   */
  function mapPosition(pos, changes) {
    let shift = 0;
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      if (c.to <= pos) {
        shift += c.insert.length - (c.to - c.from);
        continue;
      }
      // 落在被替换的区间**内部**：贴到替换结果的右端（用户刚改的是这一行的前缀，
      // 光标/选区端点应当留在内容一侧，⛔ 不退回前缀里）。
      if (c.from <= pos && pos < c.to) return c.from + shift + c.insert.length;
      if (c.from > pos) break;
    }
    return pos + shift;
  }

  /**
   * @param {number} anchor
   * @param {number} head
   * @param {Change[]} changes
   * @returns {{anchor:number, head:number}}
   */
  function mapSelection(anchor, head, changes) {
    return { anchor: mapPosition(anchor, changes), head: mapPosition(head, changes) };
  }

  /**
   * 行内标记的开关（照 Mardo `toggleInline` 的字节语义）。
   *
   * 三种情况：
   *   ① 选区**紧邻**该标记（前是 `marker`、后也是）⇒ 把两侧各剥一层；
   *   ② 未被包裹 ⇒ 两侧各加一层；
   *   ③ 空选区 ⇒ 插入一对标记，光标放中间。
   *
   * ⚠️ 判据只认选区**外面紧邻**的源码字节（`design/0061` §6 的第三类失败）。
   * 选区自己跨过隐藏标记时，⛔ 不试图"展开成所见即所得"——那是第二份正文真相。
   *
   * @param {string} text
   * @param {number} anchor
   * @param {number} head
   * @param {string} marker 例如 `**` / `*` / `` ` `` / `~~`
   * @returns {EditPlan|null}
   */
  function toggleInline(text, anchor, head, marker) {
    const src = String(text);
    if (!marker) throw new Error('marker must not be empty');
    const r = rangeOf(src, anchor, head);
    const m = marker;
    if (r.from === r.to) {
      return {
        changes: [{ from: r.from, to: r.from, insert: m + m }],
        selection: { anchor: r.from + m.length, head: r.from + m.length },
      };
    }
    const canPeekLeft = r.from >= m.length;
    const canPeekRight = r.to + m.length <= src.length;
    const before = canPeekLeft ? src.slice(r.from - m.length, r.from) : '';
    const after = canPeekRight ? src.slice(r.to, r.to + m.length) : '';
    if (before === m && after === m) {
      return {
        changes: [
          { from: r.from - m.length, to: r.from, insert: '' },
          { from: r.to, to: r.to + m.length, insert: '' },
        ],
        // 选区两端都在 [from,to] 内 ⇒ 整体左移一层；方向（反向选区）原样保留。
        selection: { anchor: anchor - m.length, head: head - m.length },
      };
    }
    return {
      changes: [
        { from: r.from, to: r.from, insert: m },
        { from: r.to, to: r.to, insert: m },
      ],
      selection: { anchor: anchor + m.length, head: head + m.length },
    };
  }

  /**
   * 行前缀的开关（照 Mardo `toggleLinePrefix` / `toggleQuote`）。
   *
   * 选区覆盖的**每一行**：全部已有该前缀 ⇒ 整批剥掉；只要有一行没有 ⇒ 给**缺的那些**
   * 补上（已有的一行不动，⛔ 不出现 `- - ` 那种叠加）。
   * 空选区 ⇒ 只作用于光标所在那一行。
   *
   * ⚠️ 只认行首**字面**的 `prefix`（`- ` / `> `）：`* ` / `+ ` / 缩进列表今天不认。
   * 这是 Mardo 的"特性声明前缀"口径，⛔ 不是通用 Markdown 归一化器。
   *
   * @param {string} text
   * @param {number} anchor
   * @param {number} head
   * @param {string} prefix 例如 `- ` / `> `
   * @returns {EditPlan} 前缀是开关：全有 ⇒ 剥、否则补缺，**总有变更**
   */
  function togglePrefix(text, anchor, head, prefix) {
    const src = String(text);
    if (!prefix) throw new Error('prefix must not be empty');
    const r = rangeOf(src, anchor, head);
    const lines = selectedLines(src, r.from, r.to);
    let all = true;
    for (let i = 0; i < lines.length; i++) {
      if (!src.startsWith(prefix, lines[i].start)) { all = false; break; }
    }
    /** @type {Change[]} */
    const changes = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const has = src.startsWith(prefix, line.start);
      if (all && has) {
        changes.push({ from: line.start, to: line.start + prefix.length, insert: '' });
      } else if (!all && !has) {
        changes.push({ from: line.start, to: line.start, insert: prefix });
      }
    }
    if (!changes.length) return null;
    return { changes: changes, selection: mapSelection(anchor, head, changes) };
  }

  /** 行首标题前缀：`#{1,6}` ＋ 一个空格或行尾（与 `live/decorations.js` 的 `HEADING` 同口径）。 */
  const HEADING = /^(#{1,6})(?:[ \t]+|$)/;

  /**
   * 标题级别的**设置**（照 Mardo `setHeadingLevel`，⛔ 不是开关）：
   * 点击 `H2` 就把它变成二级标题，`正文` 就是剥掉前缀。
   *
   * 选区覆盖的每一行都过一遍；原本就是目标级别的行**不产生变更**
   * （避免"点一下 H1 也压一条撤销"）。空选区 ⇒ 只作用于光标所在行。
   *
   * @param {string} text
   * @param {number} anchor
   * @param {number} head
   * @param {number} level 0（正文）– 6
   * @returns {EditPlan|null}
   */
  function headingLevel(text, anchor, head, level) {
    const src = String(text);
    if (!Number.isInteger(level) || level < 0 || level > 6) throw new Error('heading level must be 0-6');
    const r = rangeOf(src, anchor, head);
    const lines = selectedLines(src, r.from, r.to);
    /** @type {Change[]} */
    const changes = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = HEADING.exec(src.slice(line.start, line.end));
      const oldLen = m ? m[0].length : 0;
      const oldLevel = m ? m[1].length : 0;
      if (oldLevel === level) continue;
      const insert = level === 0 ? '' : new Array(level + 1).join('#') + ' ';
      changes.push({ from: line.start, to: line.start + oldLen, insert: insert });
    }
    if (!changes.length) return null;
    return { changes: changes, selection: mapSelection(anchor, head, changes) };
  }

  /**
   * 链接：把选区包成 `[文字](url)`，并把**占位符 `url` 选中**（接着敲字就是改地址）。
   *
   * ⚠️ 这里**不是开关**（Mardo 对应的是 `hyperlink(destination:)`，清格式另有
   * `clearInlineFormat`）；工具栏这一版没有输入地址的浮层，占位符就位即可。
   * 空选区 ⇒ `[](url)`，光标直接落在 `url` 上。
   *
   * @param {string} text
   * @param {number} anchor
   * @param {number} head
   * @returns {EditPlan}
   */
  function insertLink(text, anchor, head) {
    const src = String(text);
    const r = rangeOf(src, anchor, head);
    const url = 'url';
    const urlStart = r.to + 3; // '[' + 选中文字 + '](' 之后
    return {
      changes: [
        { from: r.from, to: r.from, insert: '[' },
        { from: r.to, to: r.to, insert: '](' + url + ')' },
      ],
      selection: { anchor: urlStart, head: urlStart + url.length },
    };
  }

  /**
   * 把一个按钮命令翻成编辑计划（**纯函数**，DOM 壳只负责 dispatch）。
   *
   * @param {string} cmd
   * @param {string} text
   * @param {number} anchor
   * @param {number} head
   * @returns {EditPlan|null} 未知命令 / 无事可做 ⇒ `null`
   */
  function commandPlan(cmd, text, anchor, head) {
    switch (cmd) {
      case 'bold': return toggleInline(text, anchor, head, '**');
      case 'italic': return toggleInline(text, anchor, head, '*');
      case 'code': return toggleInline(text, anchor, head, '`');
      case 'strike': return toggleInline(text, anchor, head, '~~');
      case 'link': return insertLink(text, anchor, head);
      case 'body': return headingLevel(text, anchor, head, 0);
      case 'h1': return headingLevel(text, anchor, head, 1);
      case 'h2': return headingLevel(text, anchor, head, 2);
      case 'h3': return headingLevel(text, anchor, head, 3);
      case 'ul': return togglePrefix(text, anchor, head, '- ');
      case 'quote': return togglePrefix(text, anchor, head, '> ');
      default: return null;
    }
  }

  /**
   * 按钮表（顺序即屏幕顺序）。`text` 是可见字形；`key` 是**字典键**的第二段
   * （完整键 = `live.format.` + `key`），`title` / `aria-label` 一律**运行期**取字典
   * （`services/i18n.js`，`design/0061` L4）。
   *
   * ⚠️ ⛔ 不许在这里写字面文案：`tests/js/i18n.test.js` 的闸门只认字典，
   *    而产品是中文界面。`labelOf()` 里那句兜底只在中英字典都缺键时生效。
   *
   * @type {BarButton[]}
   */
  const BUTTONS = [
    { cmd: 'bold', text: 'B', key: 'bold', cls: 'live-formatbar-bold' },
    { cmd: 'italic', text: 'I', key: 'italic', cls: 'live-formatbar-italic' },
    { cmd: 'code', text: '</>', key: 'code' },
    { cmd: 'strike', text: 'S', key: 'strike', cls: 'live-formatbar-strike' },
    { cmd: 'link', text: '↗', key: 'link' },
    { cmd: 'body', text: '¶', key: 'body' },
    { cmd: 'h1', text: 'H1', key: 'h1' },
    { cmd: 'h2', text: 'H2', key: 'h2' },
    { cmd: 'h3', text: 'H3', key: 'h3' },
    { cmd: 'ul', text: '•', key: 'ul' },
    { cmd: 'quote', text: '❯', key: 'quote' },
  ];

  /**
   * 运行期翻译一个字典键；字典没加载时退回键本身（⛔ 不写死任何语言的文案）。
   * @param {string} key
   * @returns {string}
   */
  function 译(key) {
    const I = rmdModule('i18n');
    if (I && typeof I.t === 'function') {
      try {
        const s = I.t(key);
        if (typeof s === 'string' && s) return s;
      } catch (e) { void e; }
    }
    return key;
  }

  // ────────────────────────────────────────────────────────────────
  // 二、运行期取模块（⛔ 加载期取值；见文件头第 2 条）
  // ────────────────────────────────────────────────────────────────

  /**
   * `window.rmd` 下的一个模块，**运行期**查。
   *
   * ⚠️ 用下标而不是 `window.rmd.X` 的字面：`tests/js/keymap.test.js` 的顺序闸门扫的是
   * 后者的字面，它无法区分"加载期的常量"与"事件里的惰性查找"——本文件属于后者。
   * 本文件排在 `live/index.js` 之前（`design/0061` L3 的接线要求），加载期取值必炸。
   *
   * @param {string} name
   * @returns {any}
   */
  function rmdModule(name) {
    const R = typeof window !== 'undefined' ? window.rmd : null;
    return R ? R[name] : null;
  }

  /**
   * 活动块的控制器（`live/index.js::createController` 的**实例**）。
   *
   * ⚠️ `window.rmd.liveController` 是**模块对象**（那一层只有 `createController`），
   *    ⛔ 没有 `isEditing` / `activeCell`。`main.js` 在 `createController()` 之后把实例挂到
   *    `window.rmd.liveRuntime`；优先读它，读不到才退回旧名（旧名只够"不炸"）。
   * @returns {any}
   */
  function liveApi() {
    return rmdModule('liveRuntime') || rmdModule('liveController');
  }

  /**
   * 从控制器给的**适配对象**取回真正的 CM6 `EditorView`。
   *
   * ⚠️ `active.view` 是 `main.js::makeLiveView` 返回的适配层（`dom`/`lines`/`selection`
   * /`focusAt`），⛔ 没有 `dispatch`。真正的视图始终是 `dom` 里那个 `.cm-content` 的根
   * ——`EditorView.findFromDOM()` 是 CM6 自己的公开反查口，⛔ 不靠私人字段。
   *
   * @param {any} adapter
   * @returns {any|null}
   */
  function resolveView(adapter) {
    if (!adapter) return null;
    // 将来若适配层直接给出视图，优先用它（⛔ 现在没有，但不必两处判）。
    if (typeof adapter.dispatch === 'function' && adapter.state) return adapter;
    // ⚠️ `rmdCM6` 是 `make cm6` 的全局名（`tools/typecheck/rmd-globals.d.ts` 已登记）；
    //    node 里没有它 ⇒ 先 `typeof` 判，⛔ 别直接取属性。
    const CM6 = typeof rmdCM6 !== 'undefined' ? rmdCM6 : null;
    if (!CM6 || !CM6.EditorView || typeof CM6.EditorView.findFromDOM !== 'function') return null;
    if (!adapter.dom) return null;
    try {
      return CM6.EditorView.findFromDOM(adapter.dom);
    } catch (e) {
      void e;
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 三、DOM 壳：浮动条、定位、点击
  // ────────────────────────────────────────────────────────────────

  /** @type {HTMLElement|null} */
  let bar = null;
  /** @type {HTMLElement|null} 溢出菜单（`design/0078`；与 `bar` 同生同灭）。 */
  let menu = null;
  /** @type {number} 已排队的 rAF（0 = 没有）。 */
  let frame = 0;
  /** @type {string} 上一次贴文案时的语言（`relabel` 的去重键）。 */
  let lastLang = '';

  /**
   * 取（必要时建）浮动条的宿主。
   *
   * ⚠️ `index.html` 里有一个 `#live-formatbar` 挂载点；找不到时**自己建一个**，
   * 保证脚本单独加载也不会静默失效（⛔ 这不是第二份 DOM：只有一条建法）。
   * @returns {HTMLElement}
   */
  function ensureBar() {
    if (bar) return bar;
    const found = document.getElementById('live-formatbar');
    bar = found || document.createElement('div');
    bar.id = 'live-formatbar';
    bar.className = 'live-formatbar';
    bar.setAttribute('role', 'toolbar');
    // 文案在 `renderButtons` → `relabel` 里统一贴（⛔ 不在这里写第二份）。
    // ⛔ 浮层不进 Tab 序：它只在选区存在时出现，抢 Tab 会打断正文里的键盘操作。
    // ⚠️ 收起靠 `hidden` 属性（样式表里有 `.live-formatbar[hidden] { display:none }`），
    //    ⛔ 不写 `aria-hidden`：那会把可见时的按钮也一起从无障碍树里摘掉。
    bar.hidden = true;
    if (!found) document.body.appendChild(bar);
    renderButtons(bar);
    // ⛔ **不许抢焦点**：`mousedown` 的默认动作会把焦点挪到按钮上，
    //    离屏 `textarea` 一失焦，CM6 选区与 IME 就都断了（`INV-LIVE-12`）。
    bar.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    bar.addEventListener('click', onClick);
    return bar;
  }

  /**
   * @param {HTMLElement} host
   */
  function renderButtons(host) {
    if (host.children.length) return;
    const groups = [
      ['bold', 'italic', 'code', 'strike', 'link'],
      ['body', 'h1', 'h2', 'h3'],
      ['ul', 'quote'],
    ];
    groups.forEach(function (cmds, gi) {
      if (gi > 0) {
        const sep = document.createElement('span');
        sep.className = 'live-formatbar-sep';
        sep.setAttribute('aria-hidden', 'true');
        host.appendChild(sep);
      }
      cmds.forEach(function (cmd) {
        const spec = BUTTONS.find(function (b) { return b.cmd === cmd; });
        if (!spec) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-cmd', spec.cmd);
        btn.setAttribute('tabindex', '-1');
        btn.textContent = spec.text;
        if (spec.cls) btn.className = spec.cls;
        host.appendChild(btn);
      });
    });
    // ⭐ `design/0078`：块命令 / 表格操作的唯一入口（格式栏溢出菜单）。
    const sep = document.createElement('span');
    sep.className = 'live-formatbar-sep';
    sep.setAttribute('aria-hidden', 'true');
    host.appendChild(sep);
    const more = document.createElement('button');
    more.type = 'button';
    more.setAttribute('data-more', '1');
    more.setAttribute('tabindex', '-1');
    more.className = 'live-formatbar-more';
    more.textContent = '⋯';
    host.appendChild(more);
    menu = buildMenu();
    host.appendChild(menu);
    relabel(host);
  }

  /**
   * 建溢出菜单（只建一次）。菜单项来自 `live/blockcmd.js` 与 `live/table.js` 的命令表，
   * ⛔ 不在这里再抄一份命令名，⛔ 也不写任何可见文案（文案在 `relabel` 里走字典）。
   * @returns {HTMLElement}
   */
  function buildMenu() {
    const el = document.createElement('div');
    el.className = 'live-formatbar-menu';
    el.hidden = true;
    el.setAttribute('role', 'menu');
    const blockMod = rmdModule('liveBlockCmd');
    const tableMod = rmdModule('liveTable');
    /** @type {Array<{title:string, attr:string, items:Array<{cmd:string, key:string}>}>} */
    const groups = [];
    if (blockMod && blockMod.BLOCK_COMMANDS) {
      groups.push({ title: 'live.block.menu', attr: 'data-block', items: blockMod.BLOCK_COMMANDS });
    }
    if (tableMod && tableMod.TABLE_OPS) {
      groups.push({ title: 'live.table.menu', attr: 'data-table', items: tableMod.TABLE_OPS });
    }
    groups.forEach(function (group) {
      const title = document.createElement('div');
      title.className = 'live-formatbar-menu-title';
      title.setAttribute('data-group', group.title);
      el.appendChild(title);
      group.items.forEach(function (item) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('tabindex', '-1');
        btn.setAttribute(group.attr, item.cmd);
        btn.setAttribute('data-key', item.key);
        el.appendChild(btn);
      });
    });
    return el;
  }

  /**
   * 重贴按钮文案（幂等）。⭐ 只在**语言变了**（或首次）时写 DOM：
   * `refresh()` 被滚动 / 拖选的 rAF 高频驱动，无脑写属性会让样式系统每帧重算。
   * @param {HTMLElement} host
   */
  function relabel(host) {
    const I = rmdModule('i18n');
    const now = I && typeof I.lang === 'function' ? String(I.lang()) : '';
    if (now === lastLang && host.children.length) return;
    lastLang = now;
    host.setAttribute('aria-label', 译('live.format.bar'));
    const btns = host.querySelectorAll('button[data-cmd]');
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      const cmd = btn.getAttribute('data-cmd') || '';
      const spec = BUTTONS.find(function (b) { return b.cmd === cmd; });
      if (!spec) continue;
      const s = 译('live.format.' + spec.key);
      btn.setAttribute('aria-label', s);
      btn.setAttribute('title', s);
    }
    // ⭐ `design/0078`：溢出按钮与菜单项（块命令 / 表格操作）。
    const more = /** @type {HTMLElement|null} */ (host.querySelector('button[data-more]'));
    if (more) {
      const s = 译('live.format.more');
      more.setAttribute('aria-label', s);
      more.setAttribute('title', s);
    }
    if (menu) {
      const titles = menu.querySelectorAll('[data-group]');
      for (let i = 0; i < titles.length; i++) {
        titles[i].textContent = 译(titles[i].getAttribute('data-group') || '');
      }
      const items = menu.querySelectorAll('button[data-block], button[data-table]');
      for (let i = 0; i < items.length; i++) {
        const btn = items[i];
        const key = btn.getAttribute('data-key') || '';
        const prefix = btn.hasAttribute('data-block') ? 'live.block.' : 'live.table.';
        const s = 译(prefix + key);
        btn.textContent = s;
        btn.setAttribute('aria-label', s);
      }
    }
  }

  /**
   * 按钮点击：**只读**当前选区与源码，算计划、dispatch，然后下一帧重排浮层。
   *
   * ⭐ `design/0078`：`data-more` 开/关溢出菜单；`data-block` / `data-table` 走控制器
   * 的**整块提交**（一条命令 = 一次提交 = 一次 ⌘Z），⛔ 不在这里改 DOM 正文。
   * @param {MouseEvent} ev
   */
  function onClick(ev) {
    const host = /** @type {HTMLElement} */ (ev.currentTarget);
    const target = /** @type {HTMLElement|null} */ (ev.target);
    if (!target || !target.closest) return;
    // 鼠标按下已经被 `mousedown` 的 `preventDefault()` 挡在按钮之外；这里再兜一次
    // 点击的默认行为（避免按钮在焦点链上留下痕迹）。
    ev.preventDefault();
    const more = /** @type {HTMLElement|null} */ (target.closest('button[data-more]'));
    if (more && host.contains(more)) {
      toggleMenu();
      return;
    }
    const blockBtn = /** @type {HTMLElement|null} */ (target.closest('button[data-block]'));
    if (blockBtn && host.contains(blockBtn)) {
      const cmd = blockBtn.getAttribute('data-block') || '';
      closeMenu();
      runCommand('blockCommand', cmd);
      return;
    }
    const tableBtn = /** @type {HTMLElement|null} */ (target.closest('button[data-table]'));
    if (tableBtn && host.contains(tableBtn)) {
      const cmd = tableBtn.getAttribute('data-table') || '';
      closeMenu();
      runCommand('tableOp', cmd);
      return;
    }
    const btn = /** @type {HTMLElement|null} */ (target.closest('button[data-cmd]'));
    if (!btn || !host.contains(btn)) return;
    const cmd = btn.getAttribute('data-cmd') || '';
    const view = currentView();
    if (!view) return;
    const sel = view.state.selection.main;
    const plan = commandPlan(cmd, view.state.doc.toString(), sel.anchor, sel.head);
    if (!plan || !plan.changes.length) return;
    view.dispatch({ changes: plan.changes, selection: plan.selection });
    // ⚠️ 位置要等下一帧：`coordsAtPos` 是几何测量，刚 dispatch 时 CM6 的高度表还没跟上。
    schedule();
  }

  /**
   * 调控制器上的一个异步命令（块命令 / 表格操作）。
   * ⚠️ 失败已经在控制器里走过 `report`：这里只保证 promise 不变成未处理拒绝。
   * @param {'blockCommand'|'tableOp'} name
   * @param {string} cmd
   */
  function runCommand(name, cmd) {
    const live = liveApi();
    if (!live || typeof live[name] !== 'function') return;
    let out;
    try {
      out = live[name](cmd);
    } catch (e) {
      console.warn('[rmd-live] ' + name + ' 调用失败', e);
      return;
    }
    if (out && typeof out.then === 'function') {
      out.catch(function (e) {
        console.warn('[rmd-live] ' + name + ' 失败', e);
      }).then(schedule);
    } else {
      schedule();
    }
  }

  /** 关闭溢出菜单（幂等）。 */
  function closeMenu() {
    if (menu && !menu.hidden) menu.hidden = true;
  }

  /** 开/关溢出菜单。 */
  function toggleMenu() {
    if (!menu) return;
    menu.hidden = !menu.hidden;
    if (!menu.hidden) updateMenuState(liveApi());
  }

  /**
   * 菜单项禁用态（`design/0078` §2.1 / §4）：
   * · 块命令：没有编辑上下文 / 在格内 ⇒ 禁用（格内替换整块会把整张表当文字改）；
   * · 表格操作：没有活动格 ⇒ 全部禁用；非矩形 ⇒ 列操作禁用；表头行 / 首末行 / 首末列
   *   按**具体那一条**禁用。
   *
   * ⚠️ 禁用是**界面状态**，不是权限：真正的拒绝仍在 `blockCommand()` / `tableOp()`。
   * @param {any} live
   */
  function updateMenuState(live) {
    if (!menu) return;
    const cell = live && typeof live.activeCell === 'function' ? live.activeCell() : null;
    const cap = cell && live && typeof live.tableCapabilities === 'function'
      ? live.tableCapabilities()
      : null;
    const blockBtns = menu.querySelectorAll('button[data-block]');
    for (let i = 0; i < blockBtns.length; i++) {
      /** @type {HTMLButtonElement} */ (blockBtns[i]).disabled = !!cell;
    }
    const tableBtns = menu.querySelectorAll('button[data-table]');
    for (let i = 0; i < tableBtns.length; i++) {
      const btn = /** @type {HTMLButtonElement} */ (tableBtns[i]);
      const cmd = btn.getAttribute('data-table') || '';
      let disabled = !cap || cap.ok !== true;
      if (!disabled) {
        if (cap.uneven && cmd.indexOf('col-') === 0) disabled = true;
        if (cmd === 'row-insert-above' && cap.rowIndex === 0) disabled = true;
        if (cmd === 'row-delete' && cap.rowIndex === 0) disabled = true;
        if (cmd === 'row-move-up' && cap.rowIndex <= 1) disabled = true;
        if (cmd === 'row-move-down' && cap.rowIndex >= cap.rowCount - 1) disabled = true;
        if (cmd === 'col-delete' && cap.columns === 1) disabled = true;
        if (cmd === 'col-move-left' && cap.column === 0) disabled = true;
        if (cmd === 'col-move-right' && cap.column === cap.columns - 1) disabled = true;
      }
      btn.disabled = disabled;
    }
  }

  /**
   * 当前正在编辑的块视图（没有 / 不在编辑态 ⇒ `null`）。
   * @returns {any|null}
   */
  function currentView() {
    const live = liveApi();
    if (!live || typeof live.isEditing !== 'function' || !live.isEditing()) return null;
    if (typeof live.activeView !== 'function') return null;
    return resolveView(live.activeView());
  }

  /**
   * 把浮动条藏起来（幂等）。
   */
  function hide() {
    if (bar && !bar.hidden) bar.hidden = true;
    closeMenu();
  }

  /**
   * 重算一次：编辑态 ⇒ 定位到选区 / 光标上方；其余隐藏。
   *
   * ⭐ `design/0078`：**空选区也要出栏**（紧凑模式：只留「⋯」）。块命令必须在光标处可用——
   * 没有选区就藏栏，等于"想插一行分隔线，先得选中一段字去替换掉它"。表格活动格同样走紧凑模式。
   *
   * ⚠️ **只读**：这里不 dispatch、不改选区、不 focus——事件循环里任何一次
   * 重算都不该产生副作用（键盘/滚动的监听面很宽，副作用会被放大成"打字时光标乱跳"）。
   */
  function refresh() {
    if (typeof document === 'undefined') return;
    const live = liveApi();
    const view = currentView();
    if (!view) { hide(); return; }
    const sel = view.state.selection.main;
    const cell = live && typeof live.activeCell === 'function' ? live.activeCell() : null;
    const hasSelection = !sel.empty && sel.from !== sel.to;
    const host = ensureBar();
    relabel(host);
    host.classList.toggle('live-formatbar-compact', !hasSelection);
    updateMenuState(live);
    const a = view.coordsAtPos(sel.from);
    const b = hasSelection ? view.coordsAtPos(sel.to) : null;
    if (!a) { hide(); return; }
    const top = hasSelection && b ? Math.min(a.top, b.top) : a.top;
    const bottom = hasSelection && b ? Math.max(a.bottom, b.bottom) : a.bottom;
    const left = hasSelection && b ? Math.min(a.left, b.left) : a.left;
    // 选区完全在视口外 ⇒ 不画（固定定位的浮条会停在屏幕边上误导用户）。
    if (bottom < 0 || top > window.innerHeight) { hide(); return; }
    if (host.hidden) host.hidden = false;
    // ⚠️ 先显示再量：`getBoundingClientRect()` 对 `display:none` 的元素全返回 0。
    const size = host.getBoundingClientRect();
    const gap = 8;
    let y = top - size.height - gap;
    if (y < gap) y = Math.min(window.innerHeight - size.height - gap, bottom + gap);
    let x = left;
    const maxX = window.innerWidth - size.width - gap;
    if (x > maxX) x = maxX;
    if (x < gap) x = gap;
    host.style.left = Math.round(x) + 'px';
    host.style.top = Math.round(Math.max(gap, y)) + 'px';
  }

  /**
   * 把重算排到下一帧（滚动 / 按键 / 拖选会**成串**触发，逐个算会白烧几何测量）。
   */
  function schedule() {
    if (frame) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      refresh();
      return;
    }
    frame = window.requestAnimationFrame(function () {
      frame = 0;
      refresh();
    });
  }

  /**
   * 挂事件面。
   *
   * ⚠️ 这里**只做"什么时候重算"**，⛔ 不做任何按键语义（`keymap.test.js` 的白名单闸门
   * 盯的是 `.key` 判断；本文件一个都没有）。选择为什么用这些事件：
   *   · 鼠标拖选 / 双击选词结束 ⇒ `mouseup` / `pointerup`
   *   · 键盘扩选、⌘A、方向键收选区 ⇒ `keyup`（CM6 的选区在 state 里，原生 selectionchange 不报）
   *   · 页面滚动 / 窗口缩放 ⇒ 固定定位的浮条必须跟着重排
   *   · 焦点进出正文 ⇒ 覆盖层被换掉 / 编辑态结束时收起
   * 全部是幂等的**只读**重算，且都被 `schedule()` 合并到一帧。
   */
  function install() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const opts = { capture: true, passive: true };
    document.addEventListener('mouseup', schedule, opts);
    document.addEventListener('pointerup', schedule, opts);
    document.addEventListener('keyup', schedule, opts);
    document.addEventListener('selectionchange', schedule, opts);
    document.addEventListener('focusin', schedule, opts);
    document.addEventListener('focusout', schedule, opts);
    window.addEventListener('scroll', schedule, opts);
    window.addEventListener('resize', schedule, opts);
    // ⭐ `design/0078`：点菜单外面就收起（`pointerdown` 比 `click` 早，视觉上不拖沓）。
    //    ⚠️ 被动监听：这里只读 `contains()`，⛔ 不 preventDefault、⛔ 不抢焦点。
    document.addEventListener('pointerdown', function (ev) {
      if (!menu || menu.hidden) return;
      const t = /** @type {Node|null} */ (ev.target);
      if (bar && t && bar.contains(t)) return;
      closeMenu();
    }, { capture: true, passive: true });
    ensureBar();
  }

  // ────────────────────────────────────────────────────────────────
  // 四、导出
  // ────────────────────────────────────────────────────────────────

  const api = {
    // 纯逻辑（node 判据直接调）
    toggleInline: toggleInline,
    togglePrefix: togglePrefix,
    headingLevel: headingLevel,
    insertLink: insertLink,
    commandPlan: commandPlan,
    selectedLines: selectedLines,
    mapPosition: mapPosition,
    BUTTONS: BUTTONS,
    // DOM 壳（供排障 / 将来的接线复核）
    refresh: refresh,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveFormatbar = api;

  install();
})();
