// 启动页的**纯逻辑**（`design/0038` §2.1）——⛔ 不碰 DOM、⛔ 不发 IPC。
//
// # 为什么单独一份
//
// 启动页有四块判据是**可以在 `node --test` 里测的**，而它们在 DOM 里写会变成
// "只能靠人点一遍"：① `recent` 快照 → 行（名字 / `~` 路径 / 上次读的文件名）；
// ② 数字键 `1`–`9` 的映射；③ 键盘模型的**五种放行**（`INV-START-04`）；
// ④ ⭐ 「清空最近的目录」的两步确认窗口（`design/0045`，`clearConfirm`）。
// ⚠️ 本项目明令「⛔ 不能把全部正确性验证都归给人工」（根 `CLAUDE.md` §测试）——
//    留在人手里的只该是**观感**（行好看不好看、列表长度合不合适）。
//
// # 三条口径
//
// 1. ⭐ **排序/截断/`last` 标记全在后端**（`commands/mod.rs::recent_dirs`）。
//    本文件只做**展示换算**（`basename` / `tilde` / 取文件名）。⛔ 这里再排一次序
//    = 第二份派生规则，而两份分叉的表现是"行序和点击结果对不上"，谁也说不清哪份对。
// 2. ⚠️ `tilde` / `basename` **只用于显示**，⛔ 绝不据此拼路径或回传给后端——
//    回传的永远是 `row.root`（后端给的原串，`INV-START-02` 要逐字比对）。
// 3. ⚠️ 五种放行是**与**关系里的"或"：任一条成立就**整键放行**（`guard` 返回 `true`）。
//    ⛔ 别写成"只挡组合态"——那会让 `⌘O` 在启动页上被吞（用户最常用的入口）。
(function () {
  'use strict';

  /** 显示上限。⚠️ 与后端 `commands/mod.rs::RECENT_LIMIT` **同值**；⛔ 后端已截过，这里再截一次只是护栏。 */
  const MAX_ROWS = 10;

  /** 把 `/Users/xxx/...` 缩成 `~/...`。⚠️ **只用于显示**（与 `Sidebar.js` 同一条口径）。 */
  function tilde(p) {
    if (typeof p !== 'string') return '';
    return p.replace(/^\/Users\/[^/]+/, '~');
  }

  /**
   * 取路径最后一段（目录名 / 文件名）。
   * ⚠️ 先剥掉尾部分隔符：`/a/b/` 的名字是 `b`，⛔ 不是空串。
   * ⚠️ 根 `/` 剥完是空串 ⇒ 回落成 `/`（否则启动页上会出现一行没有名字的按钮）。
   */
  function basename(p) {
    if (typeof p !== 'string' || p === '') return '';
    const s = p.replace(/\/+$/, '');
    if (s === '') return '/';
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /**
   * `SessionSnapshot.recent` → 启动页的行。
   *
   * 形如 `{root, name, path, file, last}`：
   *   · `root` 原样保留（⭐ 点击时**原串**回传，后端要逐字比对）；
   *   · `name` = 目录名、`path` = `~` 缩写（两者都只显示）；
   *   · `file` = 上次读的文件**名**（`last_file` 为空 ⇒ 空串，界面上那一格不画）；
   *   · `last` = 后端给的「上次打开」标记。
   *
   * ⚠️ **不排序**（见模块头第 1 条）；`recent` 不是数组时退回空数组——空数组
   * ⇒ 启动页与今天**逐字节相同**（只有那句话，§2.1 第 2 条）。
   */
  function rows(recent) {
    if (!Array.isArray(recent)) return [];
    const out = [];
    for (let i = 0; i < recent.length && out.length < MAX_ROWS; i++) {
      const r = recent[i];
      // ⚠️ 坏行**跳过**而不是画一行空白：空白行点下去必然被后端拒绝，
      //    而用户会以为"这个目录坏了"（真正的坏目录要走 `data-missing` 那条可见路径）。
      if (!r || typeof r.root !== 'string' || r.root === '') continue;
      out.push({
        root: r.root,
        name: basename(r.root),
        path: tilde(r.root),
        file: typeof r.last_file === 'string' ? basename(r.last_file) : '',
        last: r.last === true,
      });
    }
    return out;
  }

  /**
   * ⭐ `SessionSnapshot.favorites` → 启动页**收藏**段的行（`design/0043` §2.6）。
   *
   * 形如 `{path, name, tilded}`：
   *   · `path` = 后端记录里的**原串**（⭐ 点击时原样回传，`open_favorite` 要逐字命中）；
   *   · `name` = 最后一段、`tilded` = `~` 缩写（**都只用于显示**）。
   *
   * ⚠️ **不排序、不截断、不过滤存在性**：顺序是用户排的（上移/下移落盘的顺序），
   *    而存在性只有后端在打开那一刻才判（`INV-FAV-03`）——前端先过滤一遍，
   *    分叉的表现就是"明明收藏着却看不见了"。
   * ⚠️ 坏行（不是非空字符串）**跳过**：画一行空白点下去必然被后端拒绝。
   */
  function favoriteRows(favorites) {
    if (!Array.isArray(favorites)) return [];
    const out = [];
    for (let i = 0; i < favorites.length; i++) {
      const f = favorites[i];
      if (typeof f !== 'string' || f === '') continue;
      out.push({ path: f, name: basename(f), tilded: tilde(f) });
    }
    return out;
  }

  /**
   * ⭐ 「清空最近的目录」的两步确认窗口（`design/0045`，ms）。
   * ⚠️ 与后端**无关**：它只是"第二下点得够不够快"的本地判据；
   *    真正改配置的是 `recent_apply`（`{kind:'clear'}`）。
   */
  const CLEAR_CONFIRM_MS = 3000;

  /**
   * 「清空」的两步确认判据（⭐ 纯逻辑，⛔ 不碰 DOM、⛔ 不发 IPC）。
   *
   * 为什么不是原生 `confirm()`：那是模态窗口——离屏探针够不到、也**会打断**用户正在做的事；
   * 而"清空一份历史"是可重建的低价值操作（再打开那个目录它就回来了），
   * 用一次**就地二次确认**足够，⛔ 不动系统对话框。
   *
   * @param {number} armedAt 上一次点击的时刻（`0` = 没有待确认的那一下）
   * @param {number} now 现在
   * @returns {{fire:boolean, nextArmedAt:number}}
   *   · 第一次按 ⇒ `fire=false`，`nextArmedAt=now`（按钮进入"确认清空？"态）；
   *   · 窗口内再按 ⇒ `fire=true`，复位成 `0`；
   *   · 超出窗口 / 时钟倒退 ⇒ **当成新的第一下**（⛔ 不把一次迟疑当成确认）。
   */
  function clearConfirm(armedAt, now) {
    const armed = typeof armedAt === 'number' && armedAt > 0;
    if (armed && now >= armedAt && now - armedAt <= CLEAR_CONFIRM_MS) {
      return { fire: true, nextArmedAt: 0 };
    }
    return { fire: false, nextArmedAt: now };
  }

  /**
   * 数字键 → 行下标（0 基）。不是 `1`–`9` ⇒ `-1`。
   *
   * ⚠️ `0` **不映射**：它既不是第 10 行（那需要两键），也容易与"回顶"之类的习惯冲突；
   * Startify 的默认映射也只有 `1`–`9`（`research/notes/0031` §1.2）。
   * ⚠️ 只认**单字符** `key`：`Digit1` / `Numpad1` 这类 `code` 由调用方不给
   * （`key` 本身在小键盘上也是 `'1'`，⛔ 不必再看 `code`）。
   */
  function digitIndex(key) {
    if (typeof key !== 'string' || key.length !== 1) return -1;
    const n = key.charCodeAt(0) - 48;
    return n >= 1 && n <= 9 ? n - 1 : -1;
  }

  /**
   * ⭐ `INV-START-04` 的五种放行。**任一成立 ⇒ 返回 `true`（本模型不处理这个键）**。
   *
   * @param {object} s 由 `StartScreen.js` 在 keydown 当场**现算**的四项事实：
   *   · `defaultPrevented` —— 树 / 浮层已经处理过（⭐ 必须排第一：让路优先）
   *   · `modifier` —— 带 `⌘`/`⌃`/`⌥`/`⇧`（`keymap.js::hasModifier` 的结果）
   *   · `composing` —— 输入法组合中（`isComposing` / `keyCode 229`，`INV-SET-05`）
   *   · `overlay` —— 任一覆盖层开着（设置 / 搜索 / 查找 / 图片）
   *   · `editable` —— 焦点在可编辑元素里（输入框 / textarea / select / contenteditable）
   * @returns {boolean} `true` = 放行（⛔ 别处理），`false` = 启动页可以处理
   *
   * ⚠️ 参数缺省一律按"**成立**"处理（放行）——宁可少处理一个键，
   * 也不能在启动页上吞掉本该属于别人的按键。⛔ 别把 `undefined` 当真值外的默认。
   */
  function guard(s) {
    const st = s || {};
    if (st.defaultPrevented !== false) return true; // ⭐ 唯一"默认放行"的一项
    if (st.modifier !== false) return true;
    if (st.composing !== false) return true;
    if (st.overlay !== false) return true;
    if (st.editable !== false) return true;
    return false;
  }

  const api = {
    MAX_ROWS, CLEAR_CONFIRM_MS, tilde, basename, rows, favoriteRows, clearConfirm, digitIndex, guard,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).start = api;
})();
