// 剪贴板 —— `design/0035` §2.3 的**只读能力核对** ＋ **唯一一条**写入实现。
//
// # 为什么这个文件存在（而不是在 `FileTree.js` 里写三行）
//
// 「复制绝对路径」只有一步（把字符串放进剪贴板），但它有**两个容易写错的地方**：
//
// 1. ⛔ **不许拿"试试能不能写"当探针**：`writeText()` 一旦调用就**覆盖了用户真实
//    剪贴板**。探针必须是**只读**的（`isSecureContext` / `navigator.clipboard` 在不在）。
// 2. ⛔ **不许在失败时自动换另一条路**：两条实现的失败形态不同（`Promise` 拒绝 vs
//    `boolean`），"失败了就换一条"会让"到底走哪条"变成运行期随机，判据翻倍。
//    ⇒ 本文件**按只读探针选定一条**，之后只走那一条；失败就如实报失败（§2.4）。
//
// ⚠️ 未核实（`design/0035` §8 第 1 条）：WebKit 是否把 `tauri://localhost` 当作
//    secure context —— 这正是本文件要先探一次的原因；真实写入仍然只能人工验收（§7 H1）。
//
// ⚠️ 它是**纯前端**动作（`INV-CLIP-02`）：⛔ 不写盘、⛔ 不改授权、⛔ 不新增后端命令。
(function () {
  'use strict';

  /** 用 `navigator.clipboard.writeText`（只在 secure context 里存在）。 */
  const MODE_CLIPBOARD = 'clipboard';
  /** 用 `document.execCommand('copy')`（旧的、同步的、返回 boolean）。 */
  const MODE_EXEC = 'exec';
  /** 两条都不可用 ⇒ **能力缺失**，如实说出口（§2.4 第一类）。 */
  const MODE_NONE = 'none';

  /**
   * ⭐ **只读能力 → 唯一一种实现**（§2.3 那张表）。纯函数，`node --test` 直接喂输入。
   *
   * ⚠️ 判据是 `=== true`：探针给的是布尔，⛔ 别让 `"false"` 那种字符串被真值判断读成"有"。
   * ⚠️ 顺序是**优先级**：secure context 里优先用标准 API；否则退到 `execCommand`
   * ——这不是"失败回退"，是**开跑之前就选定**（见文件头第 2 条）。
   *
   * @param {{isSecureContext?:boolean, hasClipboardWrite?:boolean, hasExecCommand?:boolean}} env
   * @returns {'clipboard'|'exec'|'none'}
   */
  function pickMode(env) {
    const e = env || {};
    if (e.isSecureContext === true && e.hasClipboardWrite === true) return MODE_CLIPBOARD;
    if (e.hasExecCommand === true) return MODE_EXEC;
    return MODE_NONE;
  }

  /**
   * 读一遍环境。⛔ **只读**：不调 `readText`、⛔ 不调 `writeText`、⛔ 不碰剪贴板。
   *
   * @param {*} [win]
   * @param {*} [doc]
   * @returns {{isSecureContext:boolean, hasClipboardWrite:boolean, hasExecCommand:boolean}}
   */
  function probe(win, doc) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const nav = w && w.navigator;
    const cb = nav && nav.clipboard;
    return {
      isSecureContext: !!(w && w.isSecureContext === true),
      hasClipboardWrite: !!(cb && typeof cb.writeText === 'function'),
      // ⚠️ `execCommand` 在不在是**只读**判断（⛔ 不调用它）
      hasExecCommand: !!(d && typeof d.execCommand === 'function'),
    };
  }

  /**
   * 一次性的**诊断**（不参与 `pickMode`）：把 `navigator.permissions.query` 的结果也记下来。
   *
   * ⚠️ WebKit 对**不认识的 permission 名**可能**抛**（不是返回 `denied`）——
   * 抛了只说明"这条查询不可用"，⛔ **不等于**"不支持剪贴板"（§2.3 的警告）。
   * ⚠️ 它**不读也不写**剪贴板内容。
   *
   * @returns {Promise<object>} 探针结果（`permission` 是状态字符串或错误名）
   */
  async function capabilities(win, doc) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const env = probe(w, d);
    let permission = null;
    let permissionError = null;
    try {
      const p = w && w.navigator && w.navigator.permissions;
      if (p && typeof p.query === 'function') {
        const st = await p.query({ name: 'clipboard-write' });
        permission = (st && st.state) || null;
      } else {
        permissionError = 'no-permissions-api';
      }
    } catch (e) {
      // ⚠️ 原样记成探针结果，⛔ 不当成"不支持剪贴板"
      permissionError = (e && (e.name || e.message)) || 'query-failed';
    }
    return {
      isSecureContext: env.isSecureContext,
      hasClipboardWrite: env.hasClipboardWrite,
      hasExecCommand: env.hasExecCommand,
      permission: permission,
      permissionError: permissionError,
      mode: pickMode(env),
    };
  }

  /** 失败类别 → 界面上那一句（由调用方翻译；⛔ 这里不存中文）。 */
  const FAIL_UNSUPPORTED = 'unsupported';
  const FAIL_DENIED = 'denied';
  const FAIL_FAILED = 'failed';

  /**
   * 造一个**按已选定模式**工作的写入器。
   *
   * ⚠️ 依赖**全部注入**（`win` / `doc` / `env`）⇒ `tests/js/clipboard.test.js` 能用
   * 假 `navigator` 验证"成功后才说成功、失败要说出来"，⛔ 不碰真剪贴板。
   *
   * @param {{win?:*, doc?:*, env?:object}} deps
   * @returns {{mode:string, copy:(text:string)=>Promise<{ok:boolean, reason?:string}>}}
   */
  function createCopier(deps) {
    const d = deps || {};
    const win = d.win || (typeof window !== 'undefined' ? window : null);
    const doc = d.doc || (typeof document !== 'undefined' ? document : null);
    const mode = pickMode(d.env || probe(win, doc));

    /**
     * ⭐ **等到真的写完才返回 `{ok:true}`**（§2.4：先报"已复制"再 catch 就是假报）。
     *
     * @param {string} text
     * @returns {Promise<{ok:boolean, reason?:string}>}
     */
    async function copy(text) {
      if (typeof text !== 'string' || !text) return { ok: false, reason: FAIL_FAILED };

      if (mode === MODE_CLIPBOARD) {
        try {
          await win.navigator.clipboard.writeText(text);
          return { ok: true };
        } catch (e) {
          return {
            ok: false,
            reason: (e && e.name === 'NotAllowedError') ? FAIL_DENIED : FAIL_FAILED,
          };
        }
      }

      if (mode === MODE_EXEC) {
        let ta = null;
        const active = doc && doc.activeElement;
        try {
          ta = doc.createElement('textarea');
          ta.value = text;
          // ⚠️ 不显示、不参与布局、不触发滚动：选中的是它的**值**，不是用户的界面
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '0';
          ta.style.left = '0';
          ta.style.opacity = '0';
          ta.style.pointerEvents = 'none';
          doc.body.appendChild(ta);
          ta.select();
          const ok = doc.execCommand('copy');
          return ok ? { ok: true } : { ok: false, reason: FAIL_FAILED };
        } catch (e) {
          return { ok: false, reason: FAIL_FAILED };
        } finally {
          if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
          // ⚠️ 把焦点还回去：⛔ 别让一次复制把用户正在打字的焦点抢走
          if (active && typeof active.focus === 'function') {
            try { active.focus(); } catch (e) { /* 焦点还回去失败不影响复制结果 */ }
          }
        }
      }

      // 能力缺失：⛔ 不说"已复制"，⛔ 也不假装尝试过
      return { ok: false, reason: FAIL_UNSUPPORTED };
    }

    return { mode: mode, copy: copy };
  }

  // ─────────────────────────────────────────────────────────────────
  // ② 多格式复制 / 读取（`design/0077`）
  // ─────────────────────────────────────────────────────────────────
  //
  // ⚠️ 上面 `copy(text)` 的语义**一个字不改**（`INV-CLIPFMT-02`）：文件树「复制绝对路径」
  //    与它共用这个模块。下面这一组只服务编辑菜单那五个动作。
  //
  // ⭐「先探针、再选定一条」的纪律与 §2.3 相同：⛔ 不写一次失败就换另一条 API 的代码
  //    （`INV-CLIPFMT-04`：失败必须可见，⛔ 不静默降级成别的格式）。

  /**
   * 读一遍**多格式写入/读取**所需的能力。⛔ 只读：不碰剪贴板内容。
   * @param {*} [win]
   * @param {*} [doc]
   * @returns {{isSecureContext:boolean, hasClipboardWriteAll:boolean,
   *            hasClipboardItem:boolean, hasBlob:boolean,
   *            hasReadText:boolean, hasExecCommand:boolean}}
   */
  function probeFormats(win, doc) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const cb = w && w.navigator && w.navigator.clipboard;
    return {
      isSecureContext: !!(w && w.isSecureContext === true),
      hasClipboardWriteAll: !!(cb && typeof cb.write === 'function'),
      hasClipboardItem: !!(w && typeof w.ClipboardItem === 'function'),
      hasBlob: !!((w && typeof w.Blob === 'function') ||
        (typeof Blob !== 'undefined' && typeof Blob === 'function')),
      hasReadText: !!(cb && typeof cb.readText === 'function'),
      hasExecCommand: !!(d && typeof d.execCommand === 'function'),
    };
  }

  /**
   * 多格式写入的**开跑前**模式选择（纯函数）。
   * @param {{isSecureContext?:boolean, hasClipboardWriteAll?:boolean,
   *          hasClipboardItem?:boolean, hasBlob?:boolean,
   *          hasExecCommand?:boolean}} env
   * @returns {'clipboard'|'exec'|'none'}
   */
  function pickFormatMode(env) {
    const e = env || {};
    if (e.isSecureContext === true && e.hasClipboardWriteAll === true &&
        e.hasClipboardItem === true && e.hasBlob === true) {
      return MODE_CLIPBOARD;
    }
    if (e.hasExecCommand === true) return MODE_EXEC;
    return MODE_NONE;
  }

  /** 条目形状的兜底校验：空数组 / 非字符串正文 ⇒ 不写。 */
  function validEntries(entries) {
    if (!Array.isArray(entries) || !entries.length) return false;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || typeof e.mime !== 'string' || !e.mime) return false;
      if (typeof e.text !== 'string') return false;
    }
    return true;
  }

  /**
   * 造一个多格式写入器 / 读取器。
   *
   * ⚠️ 依赖全部注入（`win` / `doc` / `env`）⇒ 单测能用假 `ClipboardItem` / 假 `Blob` /
   *    假 `copy` 事件验证，⛔ 不碰真剪贴板。
   *
   * @param {{win?:*, doc?:*, env?:object}} deps
   * @returns {{mode:string, write:(entries:Array<{mime:string,text:string}>)=>Promise<{ok:boolean,reason?:string}>,
   *            read:()=>Promise<{ok:boolean,text?:string,reason?:string}>}}
   */
  function createFormatCopier(deps) {
    const d = deps || {};
    const win = d.win || (typeof window !== 'undefined' ? window : null);
    const doc = d.doc || (typeof document !== 'undefined' ? document : null);
    const mode = pickFormatMode(d.env || probeFormats(win, doc));

    /** 标准 API：一个 `ClipboardItem` 里装全部 MIME。 */
    async function writeClipboard(entries) {
      const CI = win && win.ClipboardItem;
      const BlobCtor = (win && win.Blob) ||
        (typeof Blob !== 'undefined' ? Blob : null);
      const cb = win && win.navigator && win.navigator.clipboard;
      if (typeof CI !== 'function' || typeof BlobCtor !== 'function' || !cb) {
        return { ok: false, reason: FAIL_UNSUPPORTED };
      }
      let item = null;
      try {
        const parts = {};
        for (let i = 0; i < entries.length; i++) {
          parts[entries[i].mime] = new BlobCtor([entries[i].text], { type: entries[i].mime });
        }
        item = new CI(parts);
      } catch (e) {
        // ⚠️ 某些平台不接受某个 MIME（典型是 `text/html`）⇒ 这是**能力缺口**，
        //    ⛔ 不许偷偷只写 `text/plain` 然后报「已复制」。
        return { ok: false, reason: FAIL_UNSUPPORTED };
      }
      try {
        await cb.write([item]);
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          reason: (e && e.name === 'NotAllowedError') ? FAIL_DENIED : FAIL_FAILED,
        };
      }
    }

    /** 旧路径：一次性 `copy` 监听里把每个 MIME 塞进 `clipboardData`。 */
    function writeExec(entries) {
      return new Promise(function (resolve) {
        if (!doc || typeof doc.addEventListener !== 'function' ||
            typeof doc.execCommand !== 'function') {
          resolve({ ok: false, reason: FAIL_UNSUPPORTED });
          return;
        }
        const active = doc.activeElement;
        let ta = null;
        let wroteCustom = false;
        let expectedCustom = false;
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].mime !== 'text/plain') expectedCustom = true;
        }
        function onCopy(ev) {
          // ⚠️ 没有 `clipboardData` ⇒ 只能走浏览器默认（纯文本选区）；
          //    需要自定义 MIME 的那几种会在下面被判失败，⛔ 不冒充成功。
          if (!ev || !ev.clipboardData ||
              typeof ev.clipboardData.setData !== 'function') return;
          try {
            ev.preventDefault();
            for (let i = 0; i < entries.length; i++) {
              ev.clipboardData.setData(entries[i].mime, entries[i].text);
            }
            wroteCustom = true;
          } catch (e) {
            // 单个 MIME 被拒 ⇒ `wroteCustom` 保持假，最终按失败报。
          }
        }
        function cleanup() {
          try { doc.removeEventListener('copy', onCopy, true); } catch (e) { /* 无监听面 */ }
          if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
          if (active && typeof active.focus === 'function') {
            try { active.focus(); } catch (e) { /* 焦点还回去失败不影响结果 */ }
          }
        }
        try {
          doc.addEventListener('copy', onCopy, true);
          ta = doc.createElement('textarea');
          const plain = entries.filter(function (e) { return e.mime === 'text/plain'; })[0];
          ta.value = plain ? plain.text : '';
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '0';
          ta.style.left = '0';
          ta.style.opacity = '0';
          ta.style.pointerEvents = 'none';
          doc.body.appendChild(ta);
          ta.select();
          const ok = doc.execCommand('copy');
          const good = !!ok && (!expectedCustom || wroteCustom);
          resolve(good ? { ok: true } : { ok: false, reason: FAIL_FAILED });
        } catch (e) {
          resolve({ ok: false, reason: FAIL_FAILED });
        } finally {
          cleanup();
        }
      });
    }

    /**
     * ⭐ 等到真的写完才返回 `{ok:true}`。
     * @param {Array<{mime:string,text:string}>} entries
     * @returns {Promise<{ok:boolean,reason?:string}>}
     */
    async function write(entries) {
      if (!validEntries(entries)) return { ok: false, reason: FAIL_FAILED };
      if (mode === MODE_CLIPBOARD) return writeClipboard(entries);
      if (mode === MODE_EXEC) return writeExec(entries);
      return { ok: false, reason: FAIL_UNSUPPORTED };
    }

    /**
     * 读取剪贴板文本。⚠️ 只读 `text/plain`；富文本格式一律忽略（`INV-CLIPFMT-08`）。
     * @returns {Promise<{ok:boolean,text?:string,reason?:string}>}
     */
    async function read() {
      const cb = win && win.navigator && win.navigator.clipboard;
      if (!cb || typeof cb.readText !== 'function') {
        return { ok: false, reason: FAIL_UNSUPPORTED };
      }
      try {
        const text = await cb.readText();
        return { ok: true, text: typeof text === 'string' ? text : '' };
      } catch (e) {
        return {
          ok: false,
          reason: (e && e.name === 'NotAllowedError') ? FAIL_DENIED : FAIL_FAILED,
        };
      }
    }

    return { mode: mode, write: write, read: read };
  }

  /** 产品路径用的那一个（惰性建，只建一次）。 */
  let shared = null;
  function defaultCopier() {
    if (!shared) shared = createCopier({});
    return shared;
  }

  let sharedFormats = null;
  function defaultFormatCopier() {
    if (!sharedFormats) sharedFormats = createFormatCopier({});
    return sharedFormats;
  }

  const api = {
    MODE_CLIPBOARD: MODE_CLIPBOARD,
    MODE_EXEC: MODE_EXEC,
    MODE_NONE: MODE_NONE,
    FAIL_UNSUPPORTED: FAIL_UNSUPPORTED,
    FAIL_DENIED: FAIL_DENIED,
    FAIL_FAILED: FAIL_FAILED,
    pickMode: pickMode,
    probe: probe,
    capabilities: capabilities,
    createCopier: createCopier,
    defaultCopier: defaultCopier,
    probeFormats: probeFormats,
    pickFormatMode: pickFormatMode,
    createFormatCopier: createFormatCopier,
    defaultFormatCopier: defaultFormatCopier,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).clipboard = api;
})();
