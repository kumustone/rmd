// 新窗口的**待处理导航**规划（`design/0071` §5 / `design/0068` §2.4–§2.6）——⛔ 不碰 DOM、⛔ 不发 IPC。
//
// # 它解决的问题
//
// 「在新窗口中打开」是**两步**：旧窗口发 `open_in_new_window`（后端建窗、把
// `pending_navigation = {kind, value}` 塞进新窗口的会话），新窗口起来之后自己取走
// （`take_pending_navigation`）并**在自己的会话里**再走一次既有的打开入口。
// 本文件只管第二步里**纯的那一段**：把后端交回来的 `{kind, value}` 翻译成
// 「该调哪条既有命令」。
//
// # 三条口径
//
// 1. ⛔ **不拼路径**：`value` 是后端记录里的**原串**（最近目录的根 / 收藏的路径），
//    要逐字回传给授权命令（`INV-START-02` / `INV-FAV-03`）。这里做任何规范化或
//    `~` 展开都会让"逐字命中"失效。
// 2. ⛔ **不判断可达性、不判断类型**：能不能打开、是目录还是文件，全部由新窗口
//    自己的命令（`open_recent_directory` / `open_favorite`）决定——
//    `pending_navigation` **不是授权**（`INV-FS-03` / Q40：新窗口不继承任何权限）。
// 3. ⚠️ 形状不认识就**返回 `null`**（后端版本更新、字段缺失、空串）：调用方据此
//    什么都不做。⛔ 别抛异常——启动流程不该为一条过期导航变量中断。
(function () {
  'use strict';

  /**
   * 把 `take_pending_navigation` 的返回值翻成一个动作计划。
   *
   * @param {*} nav 后端交回的 `PendingNavigation | null`
   * @returns {null | {cmd: 'open_recent_directory' | 'open_favorite', value: string}}
   *   `null` = 没有待处理导航 / 形状不认识（调用方什么都不做）。
   */
  function plan(nav) {
    if (!nav || typeof nav !== 'object') return null;
    const kind = nav.kind;
    const value = nav.value;
    // ⚠️ 空串不是合法记录：授权命令要「逐字命中」一条真实记录，空串永远命中不了。
    if (typeof value !== 'string' || value === '') return null;
    if (kind === 'recent') return { cmd: 'open_recent_directory', value: value };
    if (kind === 'favorite') return { cmd: 'open_favorite', value: value };
    return null;
  }

  const api = { plan };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).windownav = api;
})();
