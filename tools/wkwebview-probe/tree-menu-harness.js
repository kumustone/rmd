// rmd · 文件树右键菜单（复制绝对路径 ＋ 重命名）的**真 DOM 离屏探针**
// （`design/0034` §8 第 5 条欠的那份；`design/0035` §3.8 的 A4 / B8–B13 挂在它上面）
//
// ⭐ 跑的是**产品那几份**，原样拷进页面，⛔ 探针不抄第二份实现：
//    · `src/services/treerefresh.js` —— 右键目标 / 复制目标 / 重命名目标 / 选区 / 文案映射；
//    · `src/services/clipboard.js`   —— 能力核对与**唯一一条**写入实现；
//    · `src/components/FileTree.js`  —— 菜单、就地输入行、提交、失败保留、收尾；
//    · `src/services/session.js` ＋ `versions.js` ＋ `chunked.js` ＋ `search.js`
//      ＋ `dirsession.js` ＋ `tauri.js` ＋ `i18n.js` —— 树读一层、改名命令、文案。
//
// ⚠️⚠️ **假剪贴板，⛔ 不碰用户真剪贴板**（根 `CLAUDE.md` 工作约定 4，
//    用户本轮授权：「不自动运行会抢焦点、合成系统输入或写用户剪贴板的验证」）：
//    产品 `FileTree.js` 调的是 `CLIP.defaultCopier()`，本探针在**跑任何判据之前**
//    把它换成 `createCopier({win: 假 win, env: 固定 clipboard 模式})`——
//    `writeText` 只是一个记账的桩子，**真 `window.navigator.clipboard` 一次都不会被调到**。
//    ⇒ 「真实写入能否成功」仍然只能人工验收（§7 H1），这里验的是**接线与诚实反馈**。
//
// ⚠️ 假后端只下沉到 `window.__TAURI__.core.invoke` 那一层：只有「磁盘里有什么」是假的，
//    `session.js` 的提交判据、`FileTree.js` 的事务与收尾、`clipboard.js` 的模式选择全都真跑。
//
// ⚠️ 离屏的安全形态：本文件只改**自己页面里的 DOM**、只在页面内 `dispatchEvent` /
//    `element.click()`（不可信事件，⛔ 不点亮任何系统级输入）。窗口由 `.swift` 那边
//    `alphaValue = 0` ＋ `orderBack` 建成，⛔ 全程不 `NSApp.activate`、⛔ 不 `makeKey`。
//
// 约定：`window.__RUN()` 返回 `{环境, 夹具, 检查, 结论}`；判据在**退出码**上（`.sh` 聚合）。
(function () {
  'use strict';

  // ⚠️ file:// 下 WebKit 只报一句 "Script error."（没有文件名/行号）⇒ 自己把栈留下，
  //    否则"harness 没跑起来"会与"某份产品脚本没加载"长得一模一样。
  try {

  const S = window.rmd.session;
  const R = window.rmd.treeRefresh;
  const CLIP = window.rmd.clipboard;
  const FT = window.rmd.fileTree;
  const I18N = window.rmd.i18n;
  const t = I18N ? I18N.t : function (k) { return k; };

  const ROOT = '/probe/wiki';
  const OTHER = '/probe/other';
  const host = document.getElementById('pane-tree');

  // ── 假文件系统：只有「磁盘里有什么」是假的 ─────────────────────────────
  const FS = Object.create(null);

  function ensureDir(p) { if (!FS[p]) FS[p] = []; return p; }

  function add(parent, name, isDir, ignored) {
    ensureDir(parent);
    const path = parent + '/' + name;
    FS[parent].push({ path: path, name: name, is_dir: !!isDir, ignored: !!ignored });
    if (isDir) ensureDir(path);
    return path;
  }

  ensureDir(ROOT);
  const DOCS = ROOT + '/docs';
  const WEIRD = ROOT + '/有 空 格';

  /** ⚠️ 每条判据前重建：`rename_entry` 会改这份假 FS（改名的成功路径要重列）。 */
  function buildFixture() {
    for (const k in FS) delete FS[k];
    ensureDir(ROOT);
    add(ROOT, 'a.md', false);
    add(ROOT, 'b.md', false);
    add(ROOT, 'multi.part.md', false);
    add(ROOT, 'docs', true);
    add(DOCS, 'x.md', false);
    add(ROOT, '有 空 格', true);
    add(WEIRD, 'x y.md', false);
    // ⚠️ 灰显行：`list_dir` 会把忽略清单里的目录标成 `ignored: true`
    add(ROOT, 'vendor', true, true);
    ensureDir(OTHER);
    add(OTHER, 'other.md', false);
  }
  buildFixture();

  // ⭐ 当前"授权根 / 代次"（判据 B13 要模拟换根）
  const FAKE = { root: ROOT, gen: 1 };

  function copyEntry(e) {
    return { path: e.path, name: e.name, is_dir: e.is_dir, ignored: e.ignored };
  }

  // ── 假 IPC ────────────────────────────────────────────────────────────
  const calls = Object.create(null);
  function bump(cmd) { calls[cmd] = (calls[cmd] || 0) + 1; }

  /** ⭐ `design/0048`：「在访达中显示」的回包由各条判据按需摆布：`ok` / `reject`。 */
  const REV = { behavior: 'ok', calls: [] };

  /** 改名的回包由各条判据按需摆布：`ok` / `reject` / `pending`。 */
  const REN = {
    behavior: 'ok',
    calls: [],
    pending: [],
    /** 回包里的 `current_moved`（B13 要它说"改的是当前文档"）。 */
    currentMoved: false,
  };

  /** 假 FS 里执行一次改名，让后续 `list_dir` 看到新名字（⚠️ 只服务夹具）。 */
  function doRename(a) {
    const from = String(a.from);
    const parent = from.replace(/\/[^/]*$/, '');
    const oldName = from.slice(from.lastIndexOf('/') + 1);
    let finalName = String(a.name == null ? '' : a.name).trim();
    // ⚠️ 后端 `validate_name` 的 `.md` 补齐（夹具只需这一条）
    if (finalName && finalName.indexOf('.') < 0) finalName += '.md';
    const list = FS[parent] || [];
    const i = list.findIndex(function (e) { return e.path === from; });
    if (i < 0) return { path: from, name: oldName, old_path: from, current_moved: false, watch_seq: 0, degraded: [] };
    if (finalName && finalName !== oldName) {
      const e = list.splice(i, 1)[0];
      e.name = finalName;
      e.path = parent + '/' + finalName;
      list.push(e);
    }
    return {
      path: parent + '/' + (finalName || oldName),
      name: finalName || oldName,
      old_path: from,
      current_moved: REN.currentMoved,
      watch_seq: REN.currentMoved ? 7 : 0,
      degraded: [],
    };
  }

  function fakeInvoke(cmd, args) {
    bump(cmd);
    const a = args || {};
    const st = S && S.state ? S.state : { generation: 1 };

    if (cmd === 'get_session') {
      return Promise.resolve({
        generation: FAKE.gen,
        mode: 'directory',
        roots: [FAKE.root],
        files: [],
        pending_directory: null,
        startup_document: null,
        sidebar_width: 280,
        last_directory: FAKE.root,
        reading_progress: {},
        doc_seq: 0,
        dir_session: null,
      });
    }
    if (cmd === 'list_dir') {
      const list = FS[a.path];
      if (!list) {
        return Promise.reject({
          kind: 'not_found',
          path: a.path,
          message: 'probe 的文件系统里没有 ' + a.path,
        });
      }
      return Promise.resolve({ gen: st.generation, req: a.req, entries: list.map(copyEntry) });
    }
    if (cmd === 'rename_entry') {
      REN.calls.push({ from: a.from, name: a.name });
      if (REN.behavior === 'reject') {
        return Promise.reject({
          kind: 'not_renamable',
          path: a.from,
          reason: 'not_markdown',
          message: '只能重命名 Markdown 文件',
        });
      }
      if (REN.behavior === 'pending') {
        return new Promise(function (res, rej) { REN.pending.push({ res: res, rej: rej, a: a }); });
      }
      return Promise.resolve(doRename(a));
    }
    // ⭐ `design/0048`：**只记账**——⛔ 一次都不真派发 `/usr/bin/open`
    //    （探针里跑 `open` 会真的把访达拉到前台，那是 `INV-EXT-01` 之外的另一件事：
    //    验证不许打扰用户，根 `CLAUDE.md` 工作约定 4）。
    if (cmd === 'reveal_entry') {
      REV.calls.push({ path: a.path });
      if (REV.behavior === 'reject') {
        return Promise.reject({ kind: 'io', path: a.path, message: 'probe 里故意让它失败' });
      }
      // ⚠️ 回包形状照后端：`path` 是**规范绝对路径**，`is_dir` 由后端判。
      return Promise.resolve({ path: a.path, is_dir: false });
    }
    if (cmd === 'set_dir_session') {
      return Promise.resolve({ status: 'ok', entry: null, evicted: [] });
    }
    return Promise.reject({ kind: 'not_found', message: 'probe 没实现命令 ' + cmd });
  }

  window.__TAURI__ = { core: { invoke: fakeInvoke } };

  // ── ⭐ 假剪贴板：⛔ 真 `navigator.clipboard` 一次都不碰 ─────────────────
  const BOARD = {
    writes: [],
    /** 由各条判据替换；默认立即成功。 */
    impl: function () { return Promise.resolve(); },
    /** 能力缺失那一条用的模式（`clipboard` / `exec` / `none`）。 */
    mode: CLIP.MODE_CLIPBOARD,
  };

  const fakeWin = {
    isSecureContext: true,
    navigator: {
      clipboard: {
        writeText: function (text) {
          BOARD.writes.push(text);
          return BOARD.impl(text);
        },
      },
    },
  };

  // ⚠️ 在**任何判据跑之前**换掉：产品 `FileTree.js` 每次点击都现调 `defaultCopier()`
  CLIP.defaultCopier = function () {
    if (BOARD.mode === CLIP.MODE_NONE) {
      return CLIP.createCopier({
        win: { isSecureContext: false, navigator: {} },
        doc: document,
        env: { isSecureContext: false, hasClipboardWrite: false, hasExecCommand: false },
      });
    }
    return CLIP.createCopier({
      win: fakeWin,
      doc: document,
      env: { isSecureContext: true, hasClipboardWrite: true, hasExecCommand: false },
    });
  };

  // ── 编辑器状态（`getEditorState` 的注入点，判据 B8/B9）─────────────────
  const EDIT = { editing: false, dirty: false };

  let stateChange = 0;
  const tree = FT.createFileTree({
    host: host,
    onOpenFile: function () {},
    onError: function () {},
    onStateChange: function () { stateChange += 1; },
    onUserToggle: function () {},
    getEditorState: function () { return { editing: EDIT.editing, dirty: EDIT.dirty }; },
  });

  // ── 观察工具（⛔ 不是产品判据） ─────────────────────────────────────
  function nodeByPath(p) {
    const all = host.querySelectorAll('.node');
    for (let i = 0; i < all.length; i++) if (all[i].dataset.path === p) return all[i];
    return null;
  }

  function menuEl() { return document.querySelector('.tree-menu'); }

  function menuItems() {
    const m = menuEl();
    if (!m) return [];
    return Array.prototype.slice.call(m.querySelectorAll('.tree-menu-item'));
  }

  function itemByKey(key) {
    const want = t(key);
    const items = menuItems();
    for (let i = 0; i < items.length; i++) if (items[i].textContent === want) return items[i];
    return null;
  }

  function menuLabels() { return menuItems().map(function (b) { return b.textContent; }); }

  /** 在某一行的 `.row` 上右键；`path` 为 `null` = 在树容器空白处右键。 */
  function rightClick(path) {
    const target = path === null ? host : (nodeByPath(path) && nodeByPath(path).firstElementChild);
    if (!target) throw new Error('右键目标不在树里：' + path);
    const ev = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 24, clientY: 32,
    });
    target.dispatchEvent(ev);
    return ev;
  }

  function key(el, k, extra) {
    const init = { key: k, bubbles: true, cancelable: true };
    if (extra) for (const n in extra) init[n] = extra[n];
    const ev = new KeyboardEvent('keydown', init);
    el.dispatchEvent(ev);
    return ev;
  }

  function tick(n) {
    let p = Promise.resolve();
    for (let i = 0; i < (n || 1); i++) p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
    return p;
  }

  /** 等到 `fn()` 为真（最多 1 s）。⚠️ 只用于等**异步收尾**，不用于盖住失败。 */
  async function waitFor(fn, ms) {
    const deadline = Date.now() + (ms || 1000);
    while (Date.now() < deadline) {
      if (fn()) return true;
      await tick(1);
    }
    return !!fn();
  }

  function inputRow() { return host.querySelector('.tree-input-row'); }
  function inputEl() { const r = inputRow(); return r ? r.querySelector('.tree-input') : null; }
  function noteEl() { return host.querySelector('.note'); }
  function noteText() { const n = noteEl(); return n ? n.textContent : ''; }

  /** 每条判据的起点：树回到干净状态、所有可变量复位。 */
  async function fresh() {
    REV.behavior = 'ok';
    REV.calls.length = 0;
    REN.behavior = 'ok';
    REN.calls.length = 0;
    REN.pending.length = 0;
    REN.currentMoved = false;
    BOARD.writes.length = 0;
    BOARD.impl = function () { return Promise.resolve(); };
    BOARD.mode = CLIP.MODE_CLIPBOARD;
    EDIT.editing = false;
    EDIT.dirty = false;
    S.state.currentPath = null;
    S.state.currentDoc = null;
    S.state.watchSeq = 0;
    FAKE.root = ROOT;
    FAKE.gen = 1;
    buildFixture();
    await S.refresh();
    await tree.showRoot(ROOT);
  }

  // ── 判据记录的公共形状 ──────────────────────────────────────────────
  const checks = [];
  function rec(id, name, ok, criterion, value) {
    checks.push({ id: String(id), 名: name, 结果: ok ? '通过' : '失败', 判据: criterion, 值: value });
  }

  // ════════════════════════════════════════════════════════════════════
  // A · 复制绝对路径（`design/0035` §2）
  // ════════════════════════════════════════════════════════════════════

  // A1：空白处右键 ⇒ 菜单照出（新建/刷新），但**没有**「复制绝对路径」，且不抛
  async function a1() {
    await fresh();
    rightClick(null);
    const labels = menuLabels();
    const ok = !!menuEl() && itemByKey('tree.menu.copy-path') === null &&
               itemByKey('tree.menu.rename') === null &&
               itemByKey('tree.menu.new-file') !== null &&
               (window.__LOADERR || []).length === 0;
    return {
      ok: ok,
      criterion: '空白处右键 ⇒ 菜单出现（新建/刷新在）∧ 无「复制绝对路径」∧ 无「重命名」∧ 加载期零错误',
      value: { 菜单项: labels, 加载期错误: window.__LOADERR || [] },
    };
  }

  // A2：文件行有「复制绝对路径」，文案来自字典
  async function a2() {
    await fresh();
    rightClick(ROOT + '/a.md');
    const b = itemByKey('tree.menu.copy-path');
    const ok = !!b && !b.disabled && b.textContent === t('tree.menu.copy-path') &&
               b.textContent !== 'tree.menu.copy-path';
    return {
      ok: ok,
      criterion: '文件行右键 ⇒ 菜单里有「复制绝对路径」∧ 文案是字典那句（⛔ 不是键本身）',
      value: { 菜单项: menuLabels(), 期望文案: t('tree.menu.copy-path') },
    };
  }

  // A3：目录行也有「复制绝对路径」
  async function a3() {
    await fresh();
    rightClick(DOCS);
    const b = itemByKey('tree.menu.copy-path');
    return {
      ok: !!b && !b.disabled,
      criterion: '目录行右键 ⇒ 菜单里也有「复制绝对路径」',
      value: { 菜单项: menuLabels() },
    };
  }

  // A4：灰显行不给菜单（`ignored` ⇒ 连新建都没有）
  async function a4() {
    await fresh();
    const vendor = nodeByPath(ROOT + '/vendor');
    const grey = !!vendor && vendor.classList.contains('ignored');
    rightClick(ROOT + '/vendor');
    return {
      ok: grey && menuEl() === null,
      criterion: '灰显行（ignored）右键 ⇒ 一个菜单都不出（那里不能建、也不能复制）',
      value: { '行存在且灰显': grey, 菜单: menuEl() ? menuLabels() : null },
    };
  }

  // A5：文件行复制 ⇒ 假剪贴板收到**逐字节**路径 ∧ 成功提示
  async function a5() {
    await fresh();
    const want = ROOT + '/a.md';
    rightClick(want);
    const b = itemByKey('tree.menu.copy-path');
    if (!b) throw new Error('菜单里没有「复制绝对路径」');
    b.click();
    await waitFor(function () { return noteText() === t('tree.copy.ok'); });
    const ok = BOARD.writes.length === 1 && BOARD.writes[0] === want &&
               noteText() === t('tree.copy.ok');
    return {
      ok: ok,
      criterion: '点「复制绝对路径」⇒ writeText 恰好收到 1 次、与节点路径**逐字节**相同 ∧ 出现「已复制」',
      value: { 写入: BOARD.writes.slice(), 提示: noteText(), 期望: want },
    };
  }

  // A5b：目录行、含空格与引号的路径同样逐字节
  async function a5b() {
    await fresh();
    const want = ROOT + '/有 空 格';
    rightClick(want);
    const b = itemByKey('tree.menu.copy-path');
    if (!b) throw new Error('目录行菜单里没有「复制绝对路径」');
    b.click();
    await waitFor(function () { return BOARD.writes.length > 0; });
    return {
      ok: BOARD.writes.length === 1 && BOARD.writes[0] === want,
      criterion: '含空格 / 中文的目录路径原样写入（⛔ 不 trim、⛔ 不加引号、⛔ 不转义）',
      value: { 写入: BOARD.writes.slice(), 期望: want },
    };
  }

  // A6：写入**没完成**之前不许报「已复制」
  async function a6() {
    await fresh();
    let release = null;
    BOARD.impl = function () { return new Promise(function (r) { release = r; }); };
    rightClick(ROOT + '/b.md');
    itemByKey('tree.menu.copy-path').click();
    await tick(6);
    const before = { 写入数: BOARD.writes.length, 提示: noteText() };
    release();
    await waitFor(function () { return noteText() === t('tree.copy.ok'); });
    const ok = before.写入数 === 1 && before.提示 === '' &&
               noteText() === t('tree.copy.ok');
    return {
      ok: ok,
      criterion: 'writeText 未 resolve 前提示为空 ∧ resolve 之后才出现「已复制」（⛔ 先报后 catch）',
      value: { 完成前: before, 完成后: noteText() },
    };
  }

  // A7：写入失败 ⇒ 可见的失败提示，⛔ 不说「已复制」
  async function a7() {
    await fresh();
    BOARD.impl = function () { return Promise.reject(new Error('boom')); };
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.copy-path').click();
    await waitFor(function () { return noteText() !== ''; });
    const got = noteText();
    return {
      ok: got === t('tree.copy.failed') && got !== t('tree.copy.ok'),
      criterion: 'writeText 普通失败 ⇒ 树顶出现「复制失败」∧ 不出「已复制」',
      value: { 提示: got, 期望: t('tree.copy.failed') },
    };
  }

  // A8：权限拒绝与普通失败**分开说**（三类失败各说各的）
  async function a8() {
    await fresh();
    BOARD.impl = function () {
      const e = new Error('denied');
      e.name = 'NotAllowedError';
      return Promise.reject(e);
    };
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.copy-path').click();
    await waitFor(function () { return noteText() !== ''; });
    const got = noteText();
    return {
      ok: got === t('tree.copy.denied') && got !== t('tree.copy.failed'),
      criterion: 'NotAllowedError ⇒ 提示是「系统拒绝了复制请求」（⛔ 不并到「复制失败」里）',
      value: { 提示: got, 期望: t('tree.copy.denied') },
    };
  }

  // A9：能力缺失 ⇒ 如实说「不支持」，⛔ 假装尝试过
  async function a9() {
    await fresh();
    BOARD.mode = CLIP.MODE_NONE;
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.copy-path').click();
    await waitFor(function () { return noteText() !== ''; });
    const got = noteText();
    return {
      ok: got === t('tree.copy.unsupported') && BOARD.writes.length === 0,
      criterion: '两条能力都缺 ⇒ 提示「这个环境不支持复制」∧ ⛔ 一次 writeText 都没发',
      value: { 提示: got, 期望: t('tree.copy.unsupported'), 写入: BOARD.writes.slice() },
    };
  }

  // A10：没有根 ⇒ 不拦系统菜单、也不弹自制菜单
  async function a10() {
    await fresh();
    tree.reset(null);
    const ev = rightClick(null);
    const ok = ev.defaultPrevented === false && menuEl() === null;
    return {
      ok: ok,
      criterion: '没有根（空会话）右键 ⇒ ⛔ 不 preventDefault、⛔ 不弹自制菜单（让系统菜单出现）',
      value: { defaultPrevented: ev.defaultPrevented, 菜单: menuEl() ? menuLabels() : null },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // C · 在访达中显示（`design/0048`）
  // ⚠️ 探针里 `reveal_entry` 是**记账桩子**：真派发 `/usr/bin/open` 会把访达拉到前台
  //    ⇒「访达真被唤醒、真的选中的是那一项」只能人工/目视验收（§7 那条）。
  // ════════════════════════════════════════════════════════════════════

  // C1：文件行与目录行**都有**这一项；空白处**没有**
  async function c1() {
    await fresh();
    rightClick(ROOT + '/a.md');
    const fileHas = !!itemByKey('tree.menu.reveal');
    const fileText = fileHas ? itemByKey('tree.menu.reveal').textContent : '';
    rightClick(DOCS);                                   // ⚠️ `onContextMenu` 自己先 closeMenu
    const dirHas = !!itemByKey('tree.menu.reveal');
    rightClick(null);
    const blankHas = !!itemByKey('tree.menu.reveal');
    const ok = fileHas && dirHas && !blankHas &&
               fileText === t('tree.menu.reveal') && fileText !== 'tree.menu.reveal';
    return {
      ok: ok,
      criterion: '文件行 ∧ 目录行都有「在访达中显示」（文案取自字典）∧ 空白处没有',
      value: { 文件行: fileHas, 目录行: dirHas, 空白处: blankHas,
        文案: fileText, 期望: t('tree.menu.reveal'), 菜单项: menuLabels() },
    };
  }

  // C2：文件行点它 ⇒ 恰一次 `reveal_entry`，路径**逐字节**原样（含空格/中文）
  async function c2() {
    await fresh();
    const want = WEIRD + '/x y.md';
    // ⚠️ 子行只有在**展开之后**才在树里（`fresh()` 只建到第一层）⇒ 先点开那个目录。
    const dirNode = nodeByPath(WEIRD);
    if (!dirNode) throw new Error('夹具里没有 ' + WEIRD);
    dirNode.firstElementChild.click();
    await waitFor(function () { return !!nodeByPath(want); });
    rightClick(want);
    const b = itemByKey('tree.menu.reveal');
    if (!b) throw new Error('文件行菜单里没有「在访达中显示」');
    b.click();
    await waitFor(function () { return REV.calls.length > 0; });
    await tick(4);
    const ok = REV.calls.length === 1 && REV.calls[0].path === want;
    return {
      ok: ok,
      criterion: '点它 ⇒ 恰好一次 `reveal_entry`，`path` 与节点路径**逐字节**相同（⛔ 不 trim / ⛔ 不转义）',
      value: { 调用: REV.calls.slice(), 期望: want },
    };
  }

  // C3：目录行同一件事（⛔ 前端不传类型，`open` 还是 `open -R` 由后端按规范路径判）
  async function c3() {
    await fresh();
    const want = DOCS;
    rightClick(want);
    const b = itemByKey('tree.menu.reveal');
    if (!b) throw new Error('目录行菜单里没有「在访达中显示」');
    b.click();
    await waitFor(function () { return REV.calls.length > 0; });
    await tick(4);
    const payload = REV.calls[0] || {};
    const ok = REV.calls.length === 1 && payload.path === want &&
               Object.keys(payload).join(',') === 'path';
    return {
      ok: ok,
      criterion: '目录行点它 ⇒ 恰好一次 `reveal_entry` ∧ 载荷**只有** `path`（⛔ 前端不传 `isDir`）',
      value: { 调用: REV.calls.slice(), 期望: want },
    };
  }

  // C4：成功**不说话**（访达浮上来就是反馈，⛔ 别再 flash 一句盖住它）
  async function c4() {
    await fresh();
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.reveal').click();
    await waitFor(function () { return REV.calls.length > 0; });
    await tick(6);
    const got = noteText();
    return {
      ok: REV.calls.length === 1 && got === '',
      criterion: '成功之后树顶**没有**任何提示（⛔ 不出「已打开」这类话）',
      value: { 提示: got, 调用次数: REV.calls.length },
    };
  }

  // C5：失败 ⇒ 可见的一句，且⛔ 不是「复制失败」那句
  async function c5() {
    await fresh();
    REV.behavior = 'reject';
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.reveal').click();
    await waitFor(function () { return noteText() !== ''; });
    const got = noteText();
    return {
      ok: got === t('tree.reveal.failed') && got !== t('tree.copy.failed') &&
          got !== 'tree.reveal.failed',
      criterion: '派发失败 ⇒ 树顶出现「没能打开访达」∧ ⛔ 不复用「复制失败」∧ ⛔ 不露出键名',
      value: { 提示: got, 期望: t('tree.reveal.failed') },
    };
  }

  // C6：灰显行（`ignored`）右键连菜单都不出 ⇒ 这一项自然也够不到
  async function c6() {
    await fresh();
    rightClick(ROOT + '/vendor');
    return {
      ok: menuEl() === null && REV.calls.length === 0,
      criterion: '灰显行右键 ⇒ 不出菜单、⛔ 一次 `reveal_entry` 都没发',
      value: { 菜单: menuEl() ? menuLabels() : null, 调用: REV.calls.slice() },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // B · 重命名（`design/0035` §3）
  // ════════════════════════════════════════════════════════════════════

  // B1：文件行有「重命名…」、目录行没有；两行都有复制
  async function b1() {
    await fresh();
    rightClick(ROOT + '/a.md');
    const fileHas = !!itemByKey('tree.menu.rename') && !!itemByKey('tree.menu.copy-path');
    const fileEnabled = itemByKey('tree.menu.rename').disabled === false;
    rightClick(DOCS); // 重新开一份（onContextMenu 自己先 closeMenu）
    const dirHas = !!itemByKey('tree.menu.copy-path');
    const dirRename = itemByKey('tree.menu.rename');
    return {
      ok: fileHas && fileEnabled && dirHas && dirRename === null,
      criterion: '文件行有「重命名…」（可用）∧ 目录行**没有**「重命名…」∧ 两行都有「复制绝对路径」',
      value: { 文件行: fileHas && fileEnabled, 目录行有复制: dirHas, 目录行重命名: dirRename ? menuLabels() : null },
    };
  }

  // B2：输入行初值 = 文件名；选区只到主名
  async function b2() {
    await fresh();
    rightClick(ROOT + '/multi.part.md');
    itemByKey('tree.menu.rename').click();
    await tick(1);
    const el = inputEl();
    const first = el ? { value: el.value, start: el.selectionStart, end: el.selectionEnd } : null;
    // 再开一次 `a.md`：单段主名的边界
    await fresh();
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.rename').click();
    await tick(1);
    const el2 = inputEl();
    const second = el2 ? { value: el2.value, start: el2.selectionStart, end: el2.selectionEnd } : null;
    const ok = !!first && first.value === 'multi.part.md' && first.start === 0 && first.end === 10 &&
               !!second && second.value === 'a.md' && second.start === 0 && second.end === 1;
    return {
      ok: ok,
      criterion: '初值 = 当前文件名 ∧ 选区是**最后一个点之前**（`multi.part.md` ⇒ 0..10，`a.md` ⇒ 0..1）',
      value: { 'multi.part.md': first, 'a.md': second },
    };
  }

  // B3：Enter 提交 ⇒ 恰一次请求；成功后输入行消失、树里换成新名字
  async function b3() {
    await fresh();
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.rename').click();
    await tick(1);
    const el = inputEl();
    el.value = 'renamed';
    key(el, 'Enter');
    await waitFor(function () { return !inputRow() && !!nodeByPath(ROOT + '/renamed.md'); });
    const ok = REN.calls.length === 1 &&
               REN.calls[0].from === ROOT + '/a.md' && REN.calls[0].name === 'renamed' &&
               !inputRow() && !!nodeByPath(ROOT + '/renamed.md') && !nodeByPath(ROOT + '/a.md');
    return {
      ok: ok,
      criterion: 'Enter ⇒ 恰好一次 `rename_entry(from, "renamed")` ∧ 输入行消失 ∧ 树里是 `renamed.md`（旧行没了）',
      value: { 调用: REN.calls.slice(), 新行: !!nodeByPath(ROOT + '/renamed.md'), 旧行: !!nodeByPath(ROOT + '/a.md') },
    };
  }

  // B4：连按两次 Enter 只发一次（`st.busy` 单飞）
  async function b4() {
    await fresh();
    REN.behavior = 'pending';
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.rename').click();
    await tick(1);
    const el = inputEl();
    el.value = 'twice';
    key(el, 'Enter');
    key(el, 'Enter');       // ⚠️ 第一次已经把 busy 置上了
    await tick(2);
    const n = REN.calls.length;
    // 收尾：把挂起的回包放掉，避免污染后续判据
    if (REN.pending.length) REN.pending[0].res(doRename(REN.pending[0].a));
    await tick(3);
    return {
      ok: n === 1,
      criterion: '连按两次 Enter ⇒ 后端只收到 1 次 `rename_entry`（第一次同步置 busy）',
      value: { 调用次数: n, 调用: REN.calls.slice() },
    };
  }

  // B5：Esc 取消 ⇒ 不调后端、输入行消失
  async function b5() {
    await fresh();
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.rename').click();
    await tick(1);
    const el = inputEl();
    el.value = 'should-not-happen';
    key(el, 'Escape');
    await tick(2);
    return {
      ok: REN.calls.length === 0 && !inputRow(),
      criterion: 'Escape ⇒ 输入行收起 ∧ 后端零次调用（⛔ 不把半截名字发出去）',
      value: { 调用次数: REN.calls.length, 输入行: !!inputRow() },
    };
  }

  // B6：组合态（`isComposing`）下的 Enter 不提交
  async function b6() {
    await fresh();
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.rename').click();
    await tick(1);
    const el = inputEl();
    el.value = 'ban';
    key(el, 'Enter', { isComposing: true });
    await tick(2);
    const ok = REN.calls.length === 0 && !!inputRow();
    return {
      ok: ok,
      criterion: '组合态（isComposing）按 Enter ⇒ ⛔ 不提交（中文选词那一下不能把半截拼音发出去）∧ 输入行还在',
      value: { 调用次数: REN.calls.length, 输入行: !!inputRow() },
    };
  }

  // B7：失败后输入行与内容**还在**，文案来自后端 reason
  async function b7() {
    await fresh();
    REN.behavior = 'reject';
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.rename').click();
    await tick(1);
    const el = inputEl();
    el.value = 'keep-me';
    key(el, 'Enter');
    await waitFor(function () {
      const err = host.querySelector('.tree-error');
      return !!err && !err.hidden;
    });
    const err = host.querySelector('.tree-error');
    const el2 = inputEl();
    const ok = !!el2 && el2.value === 'keep-me' && !!err && !err.hidden &&
               err.textContent === t('err.rename.not_markdown');
    return {
      ok: ok,
      criterion: '后端拒绝 ⇒ 输入行还在、内容还是「keep-me」∧ 错误行显示 `err.rename.not_markdown` 那句',
      value: {
        输入行: !!el2, 内容: el2 ? el2.value : null,
        错误: err ? { hidden: err.hidden, text: err.textContent } : null,
        期望: t('err.rename.not_markdown'),
      },
    };
  }

  // B8：当前文档在编辑态（⭐ 干净也算）⇒ 「重命名…」置灰 + 一句 title 出路
  async function b8() {
    await fresh();
    S.state.currentPath = ROOT + '/a.md';
    EDIT.editing = true;
    EDIT.dirty = false;   // ⭐ 干净也算
    rightClick(ROOT + '/a.md');
    const b = itemByKey('tree.menu.rename');
    const ok = !!b && b.disabled === true && b.title === t('tree.menu.rename.disabled-editing');
    return {
      ok: ok,
      criterion: '当前文档 + 编辑态（dirty=false）⇒ 重命名项 disabled ∧ title 是那句出路',
      value: {
        菜单项: b ? { text: b.textContent, disabled: b.disabled, title: b.title } : null,
        期望_title: t('tree.menu.rename.disabled-editing'),
      },
    };
  }

  // B9：编辑态**只挡当前文档**；别的文件行照旧可用
  async function b9() {
    await fresh();
    S.state.currentPath = ROOT + '/a.md';
    EDIT.editing = true;
    rightClick(ROOT + '/b.md');
    const b = itemByKey('tree.menu.rename');
    return {
      ok: !!b && b.disabled === false,
      criterion: '编辑的是 a.md ⇒ 右键 b.md，重命名项**不置灰**（⛔ 别因为编辑器开着就把整棵树禁掉）',
      value: { 菜单项: b ? { text: b.textContent, disabled: b.disabled } : null },
    };
  }

  // B10：菜单先开、之后换根 ⇒ 迟到的改名回包不碰新树、也不迁移当前文档身份
  async function b10() {
    await fresh();
    S.state.currentPath = ROOT + '/a.md';
    REN.behavior = 'pending';
    rightClick(ROOT + '/a.md');
    itemByKey('tree.menu.rename').click();
    await tick(1);
    const el = inputEl();
    el.value = 'late';
    key(el, 'Enter');
    await tick(2);   // 请求已在飞，挂起

    // ── 用户在这一瞬间换了根（`sessionToken` 变、`generation` 变）──
    FAKE.root = OTHER;
    FAKE.gen = 2;
    S.state.currentPath = null;      // 换根后当前文档身份已不是旧路径
    await S.refresh();
    await tree.showRoot(OTHER);
    const nodesBefore = host.querySelectorAll('.node').length;
    const listBefore = calls.list_dir || 0;

    // 回包终于到了（后端说"改的是当前文档、新 seq = 7"）
    REN.pending[0].res({
      path: OTHER + '/late.md', name: 'late.md', old_path: ROOT + '/a.md',
      current_moved: true, watch_seq: 7, degraded: [],
    });
    await tick(6);

    const ok = S.state.currentPath === null &&
               S.state.watchSeq !== 7 &&
               !inputRow() && !noteEl() &&
               host.querySelectorAll('.node').length === nodesBefore &&
               (calls.list_dir || 0) === listBefore &&
               !nodeByPath(OTHER + '/late.md');
    return {
      ok: ok,
      criterion: '改名在飞时换根 ⇒ 回包按陈旧丢弃：⛔ 不迁移 currentPath/watchSeq、⛔ 不重列树、' +
                '⛔ 不在新树里挂行、⛔ 不出提示（新树一个节点都没变）',
      value: {
        currentPath: S.state.currentPath, watchSeq: S.state.watchSeq,
        输入行: !!inputRow(), 提示: noteText(),
        新树节点数: host.querySelectorAll('.node').length, 换根前节点数: nodesBefore,
        list_dir次数: { 换根后: listBefore, 回包后: calls.list_dir || 0 },
      },
    };
  }

  // ── 总装 ────────────────────────────────────────────────────────────
  window.__RUN = async function () {
    const t0 = Date.now();
    const errors = [];

    if (!S || !R || !CLIP || !FT || !I18N) {
      return {
        致命: '产品模块没加载齐：session=' + !!S + ' treeRefresh=' + !!R +
              ' clipboard=' + !!CLIP + ' fileTree=' + !!FT + ' i18n=' + !!I18N +
              '；加载期错误：' + JSON.stringify(window.__LOADERR || []),
      };
    }

    // 起点必须真的是"目录已授权"那一格（⛔ 不猜，走真 `get_session`）
    await S.refresh();
    if (S.state.mode !== 'directory' || !S.state.roots || S.state.roots[0] !== ROOT) {
      return { 致命: '会话起步不对：mode=' + S.state.mode + ' roots=' + JSON.stringify(S.state.roots) };
    }

    const tests = [
      ['A1', '空白处右键：没有「复制绝对路径」', a1],
      ['A2', '文件行有「复制绝对路径」', a2],
      ['A3', '目录行也有「复制绝对路径」', a3],
      ['A4', '灰显行不给菜单', a4],
      ['A5', '文件行复制：逐字节 ＋ 成功提示', a5],
      ['A5b', '含空格/中文路径原样复制', a5b],
      ['A6', '写入完成前不报成功', a6],
      ['A7', '写入失败可见', a7],
      ['A8', '权限拒绝与普通失败分开说', a8],
      ['A9', '能力缺失如实说不支持', a9],
      ['A10', '没有根时不拦系统菜单', a10],
      ['B1', '文件行有重命名、目录行没有', b1],
      ['B2', '初值与主名选区', b2],
      ['B3', 'Enter 提交并重列', b3],
      ['B4', '连按两次 Enter 只发一次', b4],
      ['B5', 'Esc 取消不发请求', b5],
      ['B6', '组合态 Enter 不提交', b6],
      ['B7', '失败保留输入与内容', b7],
      ['B8', '编辑态（干净也算）置灰', b8],
      ['B9', '编辑态只挡当前文档', b9],
      ['B10', '换根后迟到的回包不碰新树', b10],
      ['C1', '文件行与目录行都有「在访达中显示」', c1],
      ['C2', '文件行：路径逐字节原样', c2],
      ['C3', '目录行：载荷只有 path', c3],
      ['C4', '成功不说话', c4],
      ['C5', '失败可见且文案独立', c5],
      ['C6', '灰显行够不到', c6],
    ];

    for (const [id, name, fn] of tests) {
      try {
        const r = await fn();
        rec(id, name, r.ok, r.criterion, r.value);
      } catch (e) {
        errors.push({ id: id, error: String((e && e.stack) || e) });
        rec(id, name, false, '抛错', String((e && e.message) || e));
      }
      // 判据之间把菜单关掉（下一段 fresh() 也会关，这里只是少留一层残留）
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}
    }

    return {
      环境: {
        加载期错误: window.__LOADERR || [],
        后端命令调用: Object.assign({}, calls),
        剪贴板: {
          '写入次数': BOARD.writes.length,
          '模式': BOARD.mode,
          '⚠️ 口径': '假剪贴板：`CLIP.defaultCopier()` 被换成 createCopier({win: 假 win})，' +
                     '真 window.navigator.clipboard 一次都没被调到；真实写入仍只能人工验收（§7 H1）',
        },
        墙钟秒: Math.round((Date.now() - t0) / 10) / 100,
        错误: errors,
      },
      夹具: {
        根: ROOT,
        内容: 'a.md / b.md / multi.part.md / docs/x.md / 有 空 格/x y.md / vendor(ignored)',
        另一个根: OTHER + '（判据 B10 换根用）',
        '⚠️ 假的那一层': 'window.__TAURI__.core.invoke（只有"磁盘里有什么"是假的）'
                          + '；tauri.js / session.js / treerefresh.js / clipboard.js / FileTree.js 全是产品原样',
        '⚠️ 假剪贴板': 'CLIP.defaultCopier 被换掉，writeText 只记账；⛔ 不碰用户真剪贴板',
        '⚠️ 镜像的接线': 'main.js 不在探针页里；本探针只驱动 FileTree 自己的公开行为'
                         + '（菜单 / 输入行 / 提交 / 失败保留），⛔ 没有复制 main.js 的任何判据',
      },
      检查: checks,
      结论: {
        通过: checks.filter(function (c) { return c.结果 === '通过'; }).length,
        失败: checks.filter(function (c) { return c.结果 === '失败'; }).length,
        跳过: 0,
      },
    };
  };

  window.__READY = true;

  } catch (e) {
    (window.__LOADERR = window.__LOADERR || []).push('harness 抛错：' + ((e && e.stack) || e));
    throw e;
  }
})();
