// 「安装 / 卸载命令行工具」的结果 → 状态条那几句话（`design/0033`）。
//
// # 它是什么
//
// 后端跑完 `cli_tool::install` / `cli_tool::uninstall` 之后，发一条
// `rmd://cli-tool` 事件，载荷形状**恒为**：
//
//     { action: "install" | "uninstall",
//       candidates: [ { path, result, detail? } ],
//       verify: { state, kind?, path? } | null }
//
// 本模块把这坨**事实**翻译成**一串（字典键 + 占位符）**。⚠️ 它是这几句话
// **唯一**的生成处（`INV-CLI-16` 的后半句）：⛔ 别在 `main.js` 里再拼一遍、
// ⛔ 也别把"逐条结论"合并成一句"成功"（唯一允许的合并是全 `absent`）。
//
// # 为什么拆成两半（`summarize` 出键、`render` 出字）
//
// ⭐ 判据与文案**必须分开**：判据（哪条结果配哪句话、`shadowed` 是文件还是别名）
// 是**有断言**的纯逻辑（`tests/js/clitool.test.js`）；文案在 `services/i18n.js` 里，
// 换语言要能**整句重画**。⇒ `summarize()` 只产出不随语言变的东西，
// `render()` 在**被调用那一刻**才查字典。
//
// ⚠️ 由此 `vars` 里可能出现**一个嵌套键**（`{ k: 'status.cli.kind.alias' }`）：
// `shadowed` 的那半句要嵌一个"别名 / 函数 / 内建命令"的词，而那个词本身也要翻译。
// ⛔ 不要在 `summarize()` 里把它翻成中文字符串——那会让切换语言后那半句停在旧语言。
//
// # 加载期
//
// ⛔ 无任何 `window.rmd.*` 依赖（连 `i18n` 也不取：`t` 由调用方注入）。
// ⚠️ 它必须排在根 `main.js` **之前**——后者在加载期就把 `window.rmd.cliTool` 取成常量
// （经典脚本按顺序执行、模块依赖是加载期取值，见 `.claude/rules/frontend.md`）。
// ✅ 自动防线 = `tests/js/keymap.test.js` 的「脚本加载顺序·依赖先于取值」。
(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────
  // 键表（⭐ 与 `services/i18n.js` 里那 22 条**逐字对应**）
  //
  // ⚠️ 这些是**线上契约的一半**：结果取值（`installed` / `not-ours` / …）由后端
  // 固定，键由这里固定，两半对不上时屏幕上是"一句缺了参数的话"而不是报错。
  // ✅ `clitool.test.js` 逐格比对这张表与字典（两门语言都要有）。
  // ────────────────────────────────────────────────────────────────
  const KEYS = {
    install: {
      installed: 'status.cli.install.installed',
      replaced: 'status.cli.install.replaced',
      already: 'status.cli.install.already',
      conflict: 'status.cli.install.conflict',
      refused: 'status.cli.install.refused',
      failed: 'status.cli.install.failed',
      cancelled: 'status.cli.install.cancelled',
    },
    uninstall: {
      uninstalled: 'status.cli.uninstall.uninstalled',
      absent: 'status.cli.uninstall.absent',
      'not-ours': 'status.cli.uninstall.not-ours',
      cancelled: 'status.cli.uninstall.cancelled',
      failed: 'status.cli.uninstall.failed',
    },
    // ⭐ 唯一的合并句：两个落点都"本来就没有"（`INV-CLI-16` ④）
    uninstallNone: 'status.cli.uninstall.none',
    verify: {
      verified: 'status.cli.verify.verified',
      'not-on-path': 'status.cli.verify.not-on-path',
      'shadowed-file': 'status.cli.verify.shadowed-file',
      'shadowed-kind': 'status.cli.verify.shadowed-kind',
      unknown: 'status.cli.verify.unknown',
    },
    kind: {
      alias: 'status.cli.kind.alias',
      function: 'status.cli.kind.function',
      builtin: 'status.cli.kind.builtin',
      keyword: 'status.cli.kind.keyword',
    },
  };

  /**
   * 哪些结果是**要报红的**。
   *
   * ⚠️ `cancelled`（用户点了取消）**不报红**、`absent`（本来就没装）**不报红**——
   * 那两件都是**正常结局**，红字会让用户以为出了问题（`design/0033` §2.3）。
   * ⚠️ `verify` 的任何一态都**不报红**：`not-on-path` / `shadowed` 是**如实告知**，
   * 不是我们做错了什么（`INV-CLI-06`）。
   */
  const ERRORS = {
    install: ['conflict', 'refused', 'failed'],
    uninstall: ['not-ours', 'failed'],
  };

  function str(v) { return v == null ? '' : String(v); }

  function list(v) { return Array.isArray(v) ? v : []; }

  /**
   * 一条候选 → 一行。
   *
   * @param {object} table `KEYS.install` / `KEYS.uninstall`
   * @param {string} fallback 结果取值认不出时用哪句（⛔ 不返回 `undefined` 的键）
   */
  function candidateLine(table, fallback, c) {
    const result = str(c && c.result);
    // ⚠️ 认不出的结果**不静默丢**：退回"失败"并把它原样放进 `{detail}`。
    //    丢掉的话状态条会停在**上一次操作**那句话上，看着像这次什么都没发生。
    const key = table[result] || fallback;
    const vars = { path: str(c && c.path) };
    if (!table[result]) vars.detail = result || '?';
    else if (c && c.detail != null) vars.detail = str(c.detail);
    return { key: key, vars: vars };
  }

  /**
   * 安装成功后那一句探测结论（`design/0033` 决定 10 的四态）。
   *
   * @param {object} v `verify` 载荷
   * @param {string} linkPath 链接路径（`not-on-path` 那句要据此报目录）
   */
  function verifyLine(v, linkPath) {
    const state = str(v && v.state);
    if (state === 'verified') return { key: KEYS.verify.verified, vars: {} };
    if (state === 'not-on-path') {
      const path = str(linkPath);
      // ⚠️ 目录**从链接路径现算**，⛔ 不另开一个线上字段：多一个字段就多一种
      //    "后端忘了送 / 前端猜"的分叉面。
      const i = path.lastIndexOf('/');
      return {
        key: KEYS.verify['not-on-path'],
        vars: { dir: i > 0 ? path.slice(0, i) : path, path: path },
      };
    }
    if (state === 'shadowed') {
      const kind = str(v && v.kind);
      if (kind === 'file') {
        return { key: KEYS.verify['shadowed-file'], vars: { path: str(v && v.path) } };
      }
      const kk = KEYS.kind[kind];
      // ⚠️ 叫不出名字的 `kind` ⇒ 归「未能判定」。⛔ 不许硬套"被别名挡住"——
      //    那是在不知道是什么的情况下编一句话（`INV-CLI-15` 的同一条精神）。
      if (kk) return { key: KEYS.verify['shadowed-kind'], vars: { kind: { k: kk } } };
      return { key: KEYS.verify.unknown, vars: {} };
    }
    return { key: KEYS.verify.unknown, vars: {} };
  }

  /**
   * 结果载荷 → **一串**（字典键 + 占位符）。⭐ 这几句话的唯一生成处。
   *
   * @param {{action?: string, candidates?: Array, verify?: object}} msg
   * @returns {Array<{key: string, vars: object}>}
   */
  function summarize(msg) {
    const m = msg || {};
    const cands = list(m.candidates);
    const action = str(m.action);

    if (action === 'uninstall') {
      // ⭐ 唯一允许的合并：两个落点**都**"本来就没有" ⇒ 一句
      //    「本来就没装（A 与 B 都没有）」。⚠️ 只要有一条不是 `absent`，
      //    就必须**逐条**说（`uninstalled + cancelled` 说成"什么都没做"是缺陷）。
      //
      // ⚠️ 传两个路径，⛔ **不在这里 `join(' 与 ')`**：那个连接词是中文，
      //    拼进来就变成载荷的一部分，切英文时那句会**夹一个汉字**
      //    （`i18n.test.js` 的源码闸门当场抓到过一次）。
      //    ⇒ 连接词归字典（zh「A 与 B」/ en「neither A nor B」）。
      // ⚠️ 只在**恰好两个**落点时合并——`INV-CLI-16` 说 uninstall 恒 2 项；
      //    形状不是那样就逐条说，⛔ 不硬套一句缺参数的模板。
      if (cands.length === 2 && cands.every(function (c) { return str(c && c.result) === 'absent'; })) {
        return [{
          key: KEYS.uninstallNone,
          vars: { a: str(cands[0] && cands[0].path), b: str(cands[1] && cands[1].path) },
        }];
      }
      return cands.map(function (c) {
        return candidateLine(KEYS.uninstall, KEYS.uninstall.failed, c);
      });
    }

    // install（⚠️ `action` 缺失/看不懂时也走这一支：`candidates` 恒 1 项，
    // 按 install 渲染比"什么都不显示"诚实）
    const lines = cands.map(function (c) {
      return candidateLine(KEYS.install, KEYS.install.failed, c);
    });
    if (m.verify) lines.push(verifyLine(m.verify, cands.length ? str(cands[0].path) : ''));
    return lines;
  }

  /**
   * 把 `summarize()` 的结果**当场**翻译并接成一行。
   *
   * @param {Array<{key: string, vars: object}>} lines
   * @param {(key: string, vars?: object) => string} [tr] 字典（`i18n.t`）；缺省用键名
   * @returns {string}
   */
  function render(lines, tr) {
    const t = typeof tr === 'function' ? tr : function (k) { return k; };
    return list(lines).map(function (line) {
      const src = (line && line.vars) || {};
      const vars = {};
      for (const k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        const v = src[k];
        // ⭐ 嵌套键（`shadowed` 那半句里的"别名/函数/内建"）：**现在**才翻译
        vars[k] = v && typeof v === 'object' && v.k ? t(v.k) : v;
      }
      return t(line.key, vars);
    }).filter(function (s) { return s !== ''; }).join(' · ');
  }

  /** 这一条要不要报红（见 `ERRORS` 的注释）。 */
  function isError(msg) {
    const m = msg || {};
    const action = str(m.action) === 'uninstall' ? 'uninstall' : 'install';
    const bad = ERRORS[action];
    return list(m.candidates).some(function (c) {
      return bad.indexOf(str(c && c.result)) >= 0;
    });
  }

  const api = {
    KEYS: KEYS,
    summarize: summarize,
    render: render,
    isError: isError,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && window) (window.rmd || (window.rmd = {})).cliTool = api;
})();
