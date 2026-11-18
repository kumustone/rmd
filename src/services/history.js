// 文档访问历史（后退 / 前进）的**纯逻辑**（`design/0069`，用户 2026-11-13 指示实施）。
//
// # 这个文件回答两个问题
//
// | 出口 | 问题 |
// |---|---|
// | `createHistory` | 「打开过的文档」这条栈怎么变、光标在哪、能不能再退/再进 |
// | `installGestures` | 鼠标侧键（wry 合成的 `button` 3/4）怎么接住，且**不误伤**别的鼠标手势 |
//
// ⚠️ **没有 I/O、没有 DOM 依赖、没有计时器**（`now` 由调用方注入）：
//    整份逻辑可以 `node --test` 覆盖，`installGestures` 用假 `win` 验。
//    ⛔ 它**不是**浏览器页面历史（`window.history`）：栈的单位是「打开过的文档」，
//    不是「页面导航」——`design/0069` §2.2 备选 A/E 已否决那条路。
//
// ⚠️ 栈里只存**后端回包的 `real_path`**（`session.js` 的同一口径）：
//    请求里那个字符串可能带软链/`..`，同一份文档会出现两条身份（`INV-HIST-02`）。
//
// ⚠️ 与 `src/` 下每个文件一样包一层 IIFE：经典脚本的顶层 `const` 共享全局词法作用域，
//    撞名会让**整个文件不执行**且 stderr 全静默（2026-10-13 真踩过，见 `main.js` 顶部）。
(function () {
  'use strict';

  /** 栈的默认上限：只存路径字符串，50 条足够覆盖一次阅读会话（`design/0069` §2.1.5）。 */
  const DEFAULT_LIMIT = 50;

  /** ⭐ 侧键 `auxclick` 的防御去重窗口（`design/0069` §2.1.1；wry 今天不合成它，见 §1.3）。 */
  const AUX_DEDUPE_MS = 100;

  function isPath(p) {
    return typeof p === 'string' && p.length > 0;
  }

  /**
   * 建一份文档访问栈。
   *
   * ⚠️ `noteOpen` 的**判据顺序就是语义**（§2.1.1）：
   *    ① 历史导航命中 `expectIndex` ⇒ 只移光标（`moved`）；
   *    ② 与当前条目同路径 ⇒ 不产生第二条（`same`）；
   *    ③ 其余 ⇒ 截断前进分支、追加、超限丢最旧（`pushed`）。
   *
   * @param {object} [opts]
   * @param {number} [opts.limit]
   */
  function createHistory(opts) {
    const conf = opts || {};
    const limit = (typeof conf.limit === 'number' && conf.limit >= 1)
      ? Math.floor(conf.limit)
      : DEFAULT_LIMIT;

    /** @type {string[]} 只存 `real_path`。 */
    let entries = [];
    /** ⭐ 当前文档在栈里的下标；`-1` = 空栈（导航页不算节点）。 */
    let cursor = -1;

    function current() {
      if (cursor < 0 || cursor >= entries.length) return null;
      return { path: entries[cursor] };
    }

    /**
     * ⭐ 一次**提交成功**的打开（`main.js::openDocument` 的提交点之后调用）。
     *
     * @param {string} path 后端回包的 `real_path`
     * @param {object} [o]
     * @param {string|null} [o.reason] `'restore'` / `'history'` / `null`
     * @param {number} [o.expectIndex] 仅 `reason === 'history'` 时有意义
     * @returns {'pushed'|'moved'|'same'}
     */
    function noteOpen(path, o) {
      if (!isPath(path)) return 'same';
      const reason = (o && o.reason) || null;
      const expectIndex = o && o.expectIndex;

      // ① 历史导航命中 ⇒ 光标移过去，条目不增删。
      //    ⚠️ `expectIndex` 可能已失效（导航在飞时别处又 push 过）——那时落到 ②/③，
      //    退化成一次普通打开，⛔ 不越界、⛔ 不硬塞光标（§2.1.1、单测第 7 条）。
      if (reason === 'history' && Number.isInteger(expectIndex) &&
          expectIndex >= 0 && expectIndex < entries.length &&
          entries[expectIndex] === path) {
        cursor = expectIndex;
        return 'moved';
      }

      // ② 连续去重：打开的就是当前这一份 ⇒ 不产生第二条。
      if (cursor >= 0 && cursor < entries.length && entries[cursor] === path) {
        return 'same';
      }

      // ③ 普通打开：截断光标之后（前进分支作废）→ 追加 → 超限丢最旧。
      if (cursor < entries.length - 1) entries = entries.slice(0, cursor + 1);
      entries.push(path);
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      cursor = entries.length - 1;
      return 'pushed';
    }

    /**
     * 光标旁边那一份。⚠️ **只读**：真正移动光标的是随后那次提交成功里的 `noteOpen`。
     *
     * @param {number} delta `-1` | `+1`
     * @returns {{path:string,index:number}|null}
     */
    function neighbor(delta) {
      if (delta !== -1 && delta !== 1) return null;
      if (cursor < 0 || cursor >= entries.length) return null;
      const idx = cursor + delta;
      if (idx < 0 || idx >= entries.length) return null;
      return { path: entries[idx], index: idx };
    }

    function canGo(delta) {
      return neighbor(delta) !== null;
    }

    /** @returns {Array<{path:string}>} 副本，⛔ 不把内部数组交出去。 */
    function list() {
      return entries.map(function (p) { return { path: p }; });
    }

    /**
     * ⭐ 当前文档改名后的对账（`design/0069` §2.1.7）。
     *
     * ⚠️ 只替换**同名条目**，然后就地折叠连续重复（改名可能让新旧路径相邻）；
     *    光标映射到折叠后的位置。⛔ 不做「按对象身份改整栈」那种事。
     *
     * @returns {number} 被替换的条目数（折叠掉的重复不计入）
     */
    function replacePath(oldPath, newPath) {
      if (!isPath(oldPath) || !isPath(newPath)) return 0;
      const out = [];
      let changed = 0;
      let nextCursor = -1;
      for (let i = 0; i < entries.length; i++) {
        let p = entries[i];
        if (p === oldPath) {
          p = newPath;
          changed++;
        }
        if (out.length && out[out.length - 1] === p) {
          // 折叠：如果光标原本落在被折掉的那条上，落到保留下来的那条。
          if (i === cursor) nextCursor = out.length - 1;
          continue;
        }
        out.push(p);
        if (i === cursor) nextCursor = out.length - 1;
      }
      entries = out;
      cursor = nextCursor;
      return changed;
    }

    function size() {
      return entries.length;
    }

    return {
      noteOpen: noteOpen,
      neighbor: neighbor,
      canGo: canGo,
      current: current,
      entries: list,
      replacePath: replacePath,
      size: size,
    };
  }

  /**
   * ⭐ 鼠标侧键识别器（`design/0069` §2.1.8 / 二期）。
   *
   * # 为什么监听 `mouseup` 而不是 `auxclick`
   *
   * wry 0.57.0 在原生视图层截走 `NSEvent.buttonNumber` 3/4，**只合成**
   * `mousedown` / `mouseup`（没有 `auxclick`、没有 `click`），
   * 并且**在 `mouseup` 未被 `preventDefault()` 时**兜底调用 `window.history.back()/forward()`
   * （`wry-0.57.0/src/wkwebview/synthetic_mouse_events.rs:58-122`）。
   * ⇒ 识别器必须**先挡后判**，`mouseup` 那次是承重的（`INV-HIST-03`）。
   * ⚠️ `auxclick` 只作**未来防御**（wry 升级可能改变合成形状，见 §1.7 U5）。
   *
   * # 不误伤既有手势（`INV-HIST-04`）
   *
   * 只认 `button === 3 || button === 4`；在 `window` **捕获阶段**
   * `preventDefault()` ＋ `stopPropagation()`，于是侧边栏行选择、正文选区、拖拽、
   * 中键（`button === 1`）、`⌘`-点击（WKWebView 的 UI 进程通道，页面本来收不到）都不受影响。
   * ⛔ 不用 `ev.isTrusted` 判据：wry 合成的事件**必然**是 `false`，用它过滤等于永不触发。
   * ⛔ 不依赖坐标与 `ev.target`：坐标被截成 `u32`，视图坐标系未核实（§1.3 后果 4）。
   *
   * @param {object} win 注入的 `window`（单测用）
   * @param {object} opts
   * @param {(delta:-1|1)=>void} opts.onNavigate
   * @param {()=>number} [opts.now]
   * @returns {{uninstall: function(): void}}
   */
  function installGestures(win, opts) {
    const noop = { uninstall: function () {} };
    if (!win || typeof win.addEventListener !== 'function') return noop;

    // 幂等：重复调用返回**同一份** uninstall，⛔ 不叠第二套监听。
    if (win.__rmdHistoryGestures) return win.__rmdHistoryGestures;

    const fn = (opts && opts.onNavigate) || function () {};
    const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now;

    let lastUpButton = 0;
    let lastUpAt = -Infinity;

    function isSide(ev) {
      return !!ev && (ev.button === 3 || ev.button === 4);
    }

    function swallow(ev) {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
      // ⚠️ `stopImmediatePropagation` 不在必需项里：捕获阶段先于 target 与冒泡，
      //    同节点上没装第二个识别器（幂等已保证），⛔ 不必多挡一层。
    }

    function go(delta) {
      try {
        fn(delta);
      } catch (e) {
        // ⚠️ 一个监听器抛错不该影响别的监听器（`design/0069` §2.1.1）。
        console.error('⛔ 文档历史：侧键导航出错：', e);
      }
    }

    function onDown(ev) {
      if (!isSide(ev)) return;
      // ⚠️ 只挡、不导航、不记状态：按住侧键拖走再松开时 `mouseup` 可能落在别处，
      //    那样最多不动作，⛔ 不会留下半截状态（§2.1.1）。
      swallow(ev);
    }

    function onUp(ev) {
      if (!isSide(ev)) return;
      swallow(ev);
      lastUpButton = ev.button;
      lastUpAt = now();
      go(ev.button === 3 ? -1 : 1);
    }

    function onAux(ev) {
      if (!isSide(ev)) return;
      swallow(ev);
      // ⚠️ 防御分支：同一按键的 `mouseup` 刚处理过就忽略，⛔ 不让"一次点击算两次"。
      if (ev.button === lastUpButton && (now() - lastUpAt) < AUX_DEDUPE_MS) return;
      go(ev.button === 3 ? -1 : 1);
    }

    win.addEventListener('mousedown', onDown, true);
    win.addEventListener('mouseup', onUp, true);
    win.addEventListener('auxclick', onAux, true);

    const handle = {
      uninstall: function () {
        win.removeEventListener('mousedown', onDown, true);
        win.removeEventListener('mouseup', onUp, true);
        win.removeEventListener('auxclick', onAux, true);
        delete win.__rmdHistoryGestures;
      },
    };
    win.__rmdHistoryGestures = handle;
    return handle;
  }

  const api = {
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    AUX_DEDUPE_MS: AUX_DEDUPE_MS,
    createHistory: createHistory,
    installGestures: installGestures,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).history = api;
})();
