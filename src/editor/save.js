// 保存的**唯一入口**（`design/0012` §2.4 / `INV-EDIT-10`）——纯逻辑，⛔ 无 DOM、⛔ 无 IPC。
//
// # ⛔ 这一个文件是「只有一条写路径」的**前端那一半**
//
// `⌘S`、工具栏「保存」按钮、将来的 `:w` **全部走这里**（§2.4-6）。
// ⛔ 不许在别处再写第二个"取出缓冲 → 发 `save_document`"的序列：
// 本项目对"两条路径说同一件事"有明文禁令（`design/0017` 的教训是用一次真金白银的事故换来的），
// 而后端那一半（`commands/edit.rs`）也照同一条纪律写。
//
// # 前端管的两件事，后端**管不了**
//
// | # | 事 | 为什么必须在前端 |
// |---|---|---|
// | 1 | **单飞闸** | 用户按住 `⌘S` 连打时，每次敲键都是一次独立的 UI 事件；后端只能"拒掉第二次"，⛔ 挡不住第一次被发出去 |
// | 2 | ⭐ **清脏标记前重判** | `rename` 期间编辑器**仍然可以输入**（§2.4-4）⇒ "我发出去的那份"与"现在缓冲里那份"可能已经不是同一份，⛔ 这时清脏 = 把一次真实的未保存改动**说成已保存** |
//
// ⚠️ 与 `src/services/reload.js` 一样：⛔ 纯逻辑、可 `node --test`、**必须**包 IIFE。
(function () {
  'use strict';

  // ⭐ 取翻译函数（`design/0025` §3）：浏览器里从 `window.rmd.i18n` 取（`i18n.js` 先加载，
  //    `INV-I18N-06`）；`node --test` 里退到 `require`——**两边是同一份字典**，
  //    ⛔ 不是在这里抄一份中文（抄了就会与字典漂，而漂的是屏幕上看不见的那一半）。
  //    ⚠️ 两个都没有时（`index.html` 少一行 `<script>`）回落成 **key 本身**：
  //    屏幕上会是一串 `save.saving`，那是**看得见的坏**（`INV-I18N-06` 的反面）。
  const I18N = (typeof window !== 'undefined' && window.rmd && window.rmd.i18n) ||
    (typeof module !== 'undefined' && module.exports ? require('../services/i18n.js') : null);
  const t = I18N ? I18N.t : function (key) { return key; };

  /**
   * 建一个保存器。
   *
   * @param {object} opts
   * @param {Function} opts.getText   `() => string` —— **现取**缓冲（⛔ 不缓存一份）
   * @param {Function} opts.rev       `() => number` —— 缓冲的**修订号**（每次 `docChanged` +1）
   * @param {Function} opts.send      `(text) => Promise<{written: boolean, bytes: number, ms: number}>`
   * @param {Function} opts.onStatus  `(text, isError) => void` —— 界面状态条
   * @param {Function} opts.onClean   `() => void` —— ⭐ **唯一的清脏动作**（见下）
   * @param {Function} [opts.onDone]  `(out) => void` —— 收尾（清提示、回报）
   * @param {Function} [opts.now]
   */
  function createSaver(opts) {
    const now = opts.now || function () { return Date.now(); };
    let inflight = false;
    let last = null;

    /**
     * ⭐ **唯一的保存入口**（`INV-EDIT-10`）。
     *
     * @returns {Promise<object|null>} `null` = 这次**没有真的发出去**（在途 / 退编辑态）。
     */
    async function save() {
      // —— 前端单飞闸（§2.4-4）——
      // ⚠️ 与后端那道 `save_in_flight` **不是重复**：后端那道防的是"两次写盘"，
      //    这一道防的是"两次 IPC ＋ 两次界面翻转"（用户会看到状态条闪两下）。
      if (inflight) {
        opts.onStatus(t('save.ignored'), false);
        return null;
      }
      if (opts.isMounted && !opts.isMounted()) return null;

      const text = opts.getText();
      // ⭐ **发出那一刻的修订号**。⚠️ 必须是"取 text 与取 rev 之间没有 await"——
      //    两次取之间一旦让出线程，用户敲的那一下就会落到窗口外面，
      //    于是"重判"会拿着一份比 `text` 还新的号去比，得出**假的安全结论**。
      const rev = opts.rev();

      inflight = true;
      opts.onStatus(t('save.saving'), false);
      let out = null;
      try {
        out = await opts.send(text);
      } catch (e) {
        // ⚠️ **失败必须可见**（`INV-EDIT-05`）：原文件一个字节没变，界面⛔ 不许说"已保存"。
        //    `wording` 是 `tauri.js` 那层给的人话（`conflict` / `save_in_flight` /
        //    `io` / `not_authorized` 各有各的说法）——⛔ 不要在这里自己拼一套。
        // ⚠️ `wording` 是 `tauri.js` 那层给的人话——它**已经是**当前语言的（那边也翻过）。
        const msg = (e && (e.wording || e.message)) || t('save.failed');
        opts.onStatus(t('save.failed-with', {
          msg: msg,
          path: e && e.path ? t('common.in-parens', { path: e.path }) : '',
        }), true);
        return null;
      } finally {
        inflight = false;
      }

      last = out;
      // ⭐ `written === false` = **no-op 短路**（还原后的字节与磁盘原文逐字节相同）。
      //    ⚠️ 界面文案**必须**与"已保存"分开：说成"已保存"会让人以为文件的时间戳动了。
      opts.onStatus(
        out && out.written === false
          ? t('save.no-change')
          : t('save.done', {
            bytes: out ? out.bytes : 0,
            ms: out ? out.ms.toFixed(1) : '0',
          }),
        false
      );

      // ⭐⭐ **清脏标记之前，把"缓冲是不是还等于刚发出去的那份"重判一次**（§2.4-4）。
      //    ⚠️ 不等的形态是最难查的那一类：磁盘上是**旧**内容，而界面说"已保存"，
      //    用户接着按 `⌘W` 就走了——一次**静默的数据丢失**。
      if (opts.rev() === rev) {
        opts.onClean();
      } else {
        // ⚠️ 仍然脏 ⇒ **说出来**（⛔ 不静默）。这不是错误，是"你刚在这几毫秒里又改了"。
        opts.onStatus(t('save.done-but-dirty'), false);
      }
      if (opts.onDone) opts.onDone(out);
      return out;
    }

    return {
      save: save,
      isInflight: function () { return inflight; },
      /** ⚠️ 只为排障：最后一次成功保存的结果。 */
      last: function () { return last; },
    };
  }

  const api = { createSaver: createSaver };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).editorSave = api;
})();
