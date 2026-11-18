// `⌘O` 打开面板的**纯逻辑**（`design/0071` §3，2026-11-14 已通过）。
//
// # 这一格守的是什么
//
// 面板的行序、上限与选中移动如果写在 DOM 里，就只能靠人点一遍才验得了；
// 而它们**恰恰是会静默错的地方**：
//   ① 文件行与目录行的先后（§3.1：同一 `updated_at` 下**文件行在前**）；
//   ② 文件行 + 目录行**合计**不超过 `RECENT_LIMIT = 10`（⛔ 不是"每类各 10 条"）；
//   ③ 空态时选中必须落在「浏览目录…」上（否则回车什么也不发生）；
//   ④ 去重：同一条记录在两处出现时只画一次（后端已经保证唯一，这里是护栏——
//      一旦出现重复，用户会看到两行一样的字，而点哪一行都对）。
//
// # 三条口径
//
// 1. ⭐ **数据只有一份**（`INV-OPEN-05`）：`recent` 就是快照里启动页用的那一条，
//    ⛔ 本文件不缓存、不排序、不记时间——排序/截断是后端的 `recent_dirs()`
//    （`commands/mod.rs:761`），这里只把"目录一行"**展开**成"文件行 + 目录行"。
// 2. ⚠️ `name` / `dir` **只用于显示**（与 `services/start.js` 同一条口径：
//    `tilde` 出来的 `~` 路径⛔ 绝不回传给后端）。回传的永远是 `path` / `root` 原串。
// 3. ⚠️ `path` 对**目录行**是 `root`、对**文件行**是 `last_file`——两者都是后端给的原串
//    （`last_file` 只在根之内，后端写入时已判过；这里⛔ 不拼、不规范化）。
(function () {
  'use strict';

  // ⭐ 显示换算复用启动页那一份（`tilde` / `basename`）——⛔ 不抄第二份，
  //    两份同义函数迟早分叉（表现是同一路径在两个界面缩写得不一样）。
  const START = (typeof module !== 'undefined' && module.exports)
    ? require('./start.js')
    : window.rmd.start;

  /**
   * 最近行上限。⚠️ 与后端 `commands/mod.rs::RECENT_LIMIT` **同值**；
   * ⚠️ 判据是「文件行 + 目录行**合计**」（`design/0071` §3.1）——⛔ 不是每类各一份。
   */
  const MAX_ROWS = 10;

  /** 面板底部的两条固定行（`§3.1`：最近列表下面是「浏览目录…」「浏览文件…」）。 */
  const BROWSE = [
    { kind: 'browse', target: 'dir' },
    { kind: 'browse', target: 'file' },
  ];

  /** 往 `out` 里放一行；到上限 / 重复了就**安静地不放**（调用方不需要知道）。 */
  function put(out, seen, cap, row) {
    if (out.length >= cap) return;
    const k = row.kind + '\u0000' + row.path;
    if (seen[k]) return;              // 护栏：后端已保证唯一，见模块头 ④
    seen[k] = true;
    out.push(row);
  }

  /**
   * `SessionSnapshot.recent` → 面板的**最近行**（文件行在前、目录行在后）。
   *
   * 每行形如 `{kind:'file'|'dir', path, root, name, dir, last}`：
   *   · `path` —— 点击时回传的**原串**（文件行 = `last_file`，目录行 = `root`）；
   *   · `root` —— 这一行属于哪个目录（文件行要用它先授权那个根，见 `main.js`）；
   *   · `name` / `dir` —— 只用于显示（最后一段 / `~` 缩写）；
   *   · `last` —— 后端给的「上次打开」标记（目录行才可能有；文件行跟着它）。
   *
   * ⚠️ **不排序**（模块头第 1 条）；坏行**跳过**而不是画一行空白——
   *    空白行点下去必然失败，而用户会以为"这一条坏了"。
   * ⚠️ 上限按**展开后**的行数算：一个"目录 + 上次文件"占 **2** 格。
   *    若只剩 1 格，**文件行优先**（它信息量更大，且单独点它也能授权那个根）。
   */
  function buildRows(recent, limit) {
    const cap = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : MAX_ROWS;
    const out = [];
    const seen = Object.create(null);
    if (!Array.isArray(recent)) return out;
    for (let i = 0; i < recent.length; i++) {
      const r = recent[i];
      if (!r || typeof r.root !== 'string' || r.root === '') continue;
      const root = r.root;
      const dirPath = START.tilde(root);
      const last = r.last === true;
      if (typeof r.last_file === 'string' && r.last_file !== '') {
        put(out, seen, cap, {
          kind: 'file',
          path: r.last_file,
          root: root,
          name: START.basename(r.last_file),
          dir: dirPath,
          last: last,
        });
      }
      put(out, seen, cap, {
        kind: 'dir',
        path: root,
        root: root,
        name: START.basename(root),
        dir: dirPath,
        last: last,
      });
      if (out.length >= cap) break;
    }
    return out;
  }

  /** 底部两条固定行（每次返回**新对象**：调用方改它不会污染下一次）。 */
  function browseRows() {
    return BROWSE.map(function (b) { return { kind: b.kind, target: b.target }; });
  }

  /**
   * 选中项移动。⭐ 环绕（长列表里从底部按 ↓ 回顶部比"卡住"好用，与 `QuickOpen` 同形）。
   * @returns {number} 新的下标；`n <= 0` ⇒ `-1`（没有可选项）
   */
  function move(sel, delta, n) {
    if (!(n > 0)) return -1;
    const from = (typeof sel === 'number' && sel >= 0 && sel < n) ? sel : 0;
    return ((from + delta) % n + n) % n;
  }

  /**
   * 一打开时选中哪一行。
   * ⚠️ 空态（只有两条浏览行）⇒ `0` 就是「浏览目录…」（`§3.1` 明文要求）；
   *    有最近行 ⇒ 选第一条最近行（与 `QuickOpen` "先选第一条"同形）。
   */
  function initialSelection(rows) {
    return Array.isArray(rows) && rows.length > 0 ? 0 : -1;
  }

  /**
   * 按键 → 面板动作（`§3.1` 的键盘模型：`↑`/`↓`/`Enter`/`Esc`）。
   *
   * ⭐ 抽成纯函数是为了让"键盘"进得了 `node --test`（与 `services/start.js::guard`、
   * `services/treerefresh.js::inputAction` 同一条理由）：本面板的键盘错误**全是静默的**——
   * `Esc` 不在 capture 里拦下，用户以为关了、其实焦点还在浮层里，接着打字全落进黑洞。
   *
   * @returns {'close'|'down'|'up'|'pick'|'focus'|''} 空串 ⇒ 放行给全局分发器
   */
  function actionForKey(e) {
    if (!e || typeof e.key !== 'string') return '';
    switch (e.key) {
      case 'Escape': return 'close';
      case 'ArrowDown': return 'down';
      case 'ArrowUp': return 'up';
      case 'Enter': return 'pick';
      // ⚠️ 焦点陷阱：本层没有可聚焦子元素 ⇒ `Tab` 一律收回面板（⛔ 放它跑去正文）。
      case 'Tab': return 'focus';
      default: return '';
    }
  }

  const api = { MAX_ROWS, buildRows, browseRows, move, initialSelection, actionForKey };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).openpanel = api;
})();
