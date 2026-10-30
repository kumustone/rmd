// ⭐ `design/0052` U8 的**唯一一处刻意放宽**：给 `src/live/**` 看得见的两个全局登记类型。
//
// ⚠️ 为什么需要它：`src/live/**` 是**经典脚本**（`frontend.md` 第 1、2 条），
//    模块之间靠 `window.rmd.*` 这个注册表互相取用（`frontend.md` 的加载顺序硬约束就是为它）。
//    `checkJs` 不知道那个注册表存在 ⇒ 把每一个 `window.rmd.blocks` 都报成
//    「Property 'rmd' does not exist on type 'Window'」，一屏噪声会把真缺陷淹掉。
//
// ⚠️⚠️ **两处都刻意是 `any`，⛔ 别"顺手"把它们补成完整接口**：
//    本单元的靶子是「**对象形状读错**」（`bugs/0014` 的 `r.head` vs `r.from`）——
//    那种错误发生在**已经拿到对象之后**（CM6 的 `SelectionRange` 之类），
//    而不是发生在"注册表里有没有这个键"上。给注册表补一份手写接口，
//    等于把 `src/live/**` 的公开面抄第二遍，抄错了还会**替产品背书**。
//    ⇒ 真正的形状检查来自 `@codemirror/*` 自带的类型（`bundler` 解析），不是来自这里。
//
// ⛔ 这个文件**只给 `make typecheck` 看**，不参与打包（放在 `tools/` 下是为了不被
//    `src-tauri/tauri.conf.json` 的 `frontendDist: "../src"` 嵌进二进制）。

/** 前端模块注册表（`src/live/*.js` 之间、以及与 `main.js` 之间唯一的耦合面）。 */
declare interface Window {
  rmd: any;
}

/** ⭐ `src/services/i18n.js` 的**注入入口**（`design/0025`）：由 `index.html` 的引导脚本写。 */
declare interface Window {
  __rmdLang?: string;
}

/** `make cm6` 打出来的 IIFE 全局（`src/vendor/cm6.bundle.js`，`global-name=rmdCM6`）。 */
declare const rmdCM6: any;
