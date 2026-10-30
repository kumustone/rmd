// 侧边栏常驻文件名搜索的**纯逻辑** —— `design/0042-侧边栏文件名搜索.md`。
//
// # 这个文件里有什么
//
// ① ⭐ **一次输入之后该做什么**（`planQuery`）：
//    空/纯空白 ⇒ 收起结果、恢复原视图，⛔ 不发 IPC；
//    从"没在搜"进入"在搜" ⇒ 那一次**强制重建索引**（与 `⌘P` 浮层打开时同一条时机，
//    `INV-SEARCH-06`）；已经在搜 ⇒ 只查不重建。
//    ⚠️ 这三分支错一个的代价**都是静默的**：每次都重建 ⇒ 每个键都等一次全树遍历；
//    从不重建 ⇒ 新文件永远搜不到，而界面上一句提示都没有（只有索引年龄那一行）。
// ② **选中项移动**（`moveSelection`）：环绕、越界归一。
//
// # ⛔ 这个文件里没有什么
//
// **没有匹配算法**。匹配与排序在 Rust（`fs/tree.rs::search`），前端只把命中的
// 字节区间换算成 UTF-16 再画（`services/search.js`）——`INV-SINGLE-01` / `INV-SEARCH-02`。
// ⛔ 也没有 DOM / Tauri / 定时器：那几样让它进不了 `node --test`（与 `search.js` 同一条纪律）。
//
// ⚠️⚠️ 每个文件都包一层 IIFE（经典脚本共享全局词法作用域，理由见 `search.js` 文件头）。

(function () {
  'use strict';

  const Se = (typeof module !== 'undefined' && module.exports)
    ? require('./search.js')
    : window.rmd.search;

  /**
   * ⭐ 输入之后的那一步。
   *
   * @param {boolean} active 现在**是不是已经**在搜（结果层是否正显示着）
   * @param {string} pattern 输入框里当刻的原文
   * @returns {{kind:'clear'}|{kind:'query', rebuild:boolean}}
   */
  function planQuery(active, pattern) {
    // ⚠️ 判据只有 `search.js::shouldQuery` 一份（"空"意味着什么，
    //    这里与 `session.searchFiles` 必须逐字同义）。
    if (!Se.shouldQuery(pattern)) return { kind: 'clear' };
    return { kind: 'query', rebuild: !active };
  }

  /**
   * 选中项移动（环绕）。
   *
   * @param {number} selected 当前下标；`-1` = 没有选中
   * @param {number} count 结果条数
   * @param {number} delta `+1` / `-1`
   * @returns {number} 新的下标；`count === 0` 时恒为 `-1`
   */
  function moveSelection(selected, count, delta) {
    const n = count > 0 ? Math.floor(count) : 0;
    if (n === 0) return -1;
    const step = (delta || 0) % n;
    // ⚠️ 没有选中时：往下从第一条开始，往上从**最后一条**开始
    //    （与 `QuickOpen.js` 的 `move()` 同一条手感，只是那份至今没有单测）。
    if (!(selected >= 0 && selected < n)) return step > 0 ? 0 : n - 1;
    return ((selected + step) % n + n) % n;
  }

  const api = { planQuery, moveSelection };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).sidebarsearch = api;
})();
