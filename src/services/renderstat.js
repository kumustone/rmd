// Q22 的「部分代码未高亮（规模限制）」那一句（`design/0007` 文末追加节）。
//
// ⚠️ **它为什么单独成文件**：这句话原本是 `main.js` 状态条里的一段内联三目。
//    那段代码的失效形态恰好是本项目最忌讳的一种——**静默**：
//    字段名写错 / 判据写反 / 后端某一版没送这个字段 ⇒ 那一句**永远不出现**，
//    而屏幕上的一切看起来都正常（状态条本来就有十几个字段）。
//    ⛔ 内联在 `main.js` 里的东西**测试碰不到**（那个文件不进 `tests/js/`），
//    所以就等于"没有防线"。抽成纯函数之后它才有断言。
//
// ⛔ **无 `window.rmd.*` 依赖** ⇒ 必须排在 `services/session.js` **之前**
//    （经典脚本按顺序执行、模块依赖是加载期取值，见 `.claude/rules/frontend.md`）。
//    ✅ 自动防线 = `tests/js/keymap.test.js` 的「脚本加载顺序·依赖先于取值」。
(function () {
  'use strict';

  /** 一个字段变成本模块认的数。⛔ 不认识的东西（缺失 / `null` / `NaN` / 字符串）一律当 0。 */
  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 中文模板（与 `services/i18n.js` 里 `doc.code-unhighlighted` 那条**逐字相同**）。
   *
   * ⚠️ 这里必须有一份**不依赖 i18n 的兜底**：本模块被 `tests/js/renderstat.test.js`
   * 用假 `window` 直接跑，⛔ 拿不到字典。`design/0025` 让译文由**调用方注入**
   * （`main.js` 传 `t`），这条兜底只服务测试与"字典没加载"那一支。
   * ✅ `renderstat.test.js` 有一条断言钉住它与字典里那张表**逐字相等**——
   * 所以这里不是"第二份文案"，是**同一句的两处引用**，漂了会红。
   */
  const DEFAULT_TPL = ' · 代码未高亮 {un} / {all} 块（规模限制，内容完整）';

  /** ⭐ `design/0060` 的对应一句（与 `services/i18n.js` 的 `doc.diagrams-unrendered` 逐字相同）。 */
  const MERMAID_TPL = ' · 图表未渲染 {un} / {all} 张（原因见文内，原文完整）';

  /**
   * 状态条上要追加的那一句；**不该显示时返回空串**（⛔ 不是 `undefined`）。
   *
   * @param {{code_unhighlighted?: number, code_highlighted?: number}} s 后端载荷
   * @param {(key: string, vars: object) => string} [tr] 翻译函数（`design/0025`）；缺省用中文模板
   */
  function codeNotice(s, tr) {
    const un = num(s && s.code_unhighlighted);
    // ⚠️ 判据是 **> 0**。⛔ 别写成 `!== 0` 或 `!= null`——
    //    前者会让"字段缺失"（`undefined`）也走进去，拼出「未高亮 NaN 块」这种
    //    **看起来像正常输出**的假话；后者同理。
    if (un <= 0) return '';
    const hi = num(s && s.code_highlighted);
    // ⭐ 分母退成 `un`：`code_highlighted` 缺失时宁可知其一半，
    //    ⛔ 也不要在用户面前印一个 `NaN`。
    const vars = { un: un, all: hi + un };
    if (typeof tr === 'function') return tr('doc.code-unhighlighted', vars);
    return DEFAULT_TPL.replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : '';
    });
  }

  /**
   * ⭐ `design/0060`：Mermaid 围栏**没画出来**的那一句；不该显示时返回空串。
   *
   * ⚠️ 措辞刻意**不说「规模限制」**：回退的成因有五种（不支持 / 语法错 / 超限 /
   *    安全拒绝 / 空图），统一的"规模限制"在另外四种上就是**假话**。
   *    ⭐ 准确的信息在**每一块自己的说明行**里（`p.rmd-diagram-note`），
   *    这句只负责"告诉用户去哪儿看"。
   * ⛔ 更不许说成"内容丢了"：回退块是**逐字原文 ＋ 一个代码块外壳**，
   *    与 `codeNotice` 那条「内容完整」是同一条纪律。
   *
   * @param {{mermaid_unrendered?: number, mermaid_rendered?: number}} s 后端载荷
   * @param {(key: string, vars: object) => string} [tr]
   */
  function mermaidNotice(s, tr) {
    const un = num(s && s.mermaid_unrendered);
    if (un <= 0) return '';
    const got = num(s && s.mermaid_rendered);
    const vars = { un: un, all: got + un };
    if (typeof tr === 'function') return tr('doc.diagrams-unrendered', vars);
    return MERMAID_TPL.replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : '';
    });
  }

  (window.rmd || (window.rmd = {})).renderstat = {
    codeNotice: codeNotice,
    mermaidNotice: mermaidNotice,
    DEFAULT_TPL: DEFAULT_TPL,
    MERMAID_TPL: MERMAID_TPL,
  };
})();
