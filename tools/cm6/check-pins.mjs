#!/usr/bin/env node
// rmd · 两份 CM6 版本清单的**一致性闸门**（`design/0012` §2.5-1 末尾那句
// 「两者版本必须**一起动**」）。
//
// ⚠️ 为什么要一个脚本：那句话是**承诺**，而承诺不会自己生效——
// 探针那份（`tools/wkwebview-probe/cm6-package.json`）是 §1.3(d) 那批实测数字的**载体**，
// 产品这份（`package.json`）是**真的要打进 bundle** 的那份。
// 两者一旦漂开，会出现最难查的一种情形：**数字对不上代码**——
// 你拿着一份量出来的结论去解释另一个版本的产物。
//
// ⛔ 反向**不判**：探针那份可以**少**几项（它只 import 它自己要量的东西，
// 比如本仓库的产品链 2026-10-15 起多了 `@codemirror/commands`——那是**编辑面**要的
// `history`，探针不装）。⭐ 所以这条闸门只查"**两边都有的**那一项版本号是否相同"。
//
// 用法：node tools/cm6/check-pins.mjs   ⇒ 一致退 0，不一致退 1 并把差异打出来。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const A = "package.json";
const B = join("tools", "wkwebview-probe", "cm6-package.json");

const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const deps = (p) => ({ ...(p.dependencies || {}), ...(p.devDependencies || {}) });

const a = deps(read(A));
const b = deps(read(B));

// ⚠️ 精确版本号的判据是"**只有数字和点**"——`^6.43.14` / `~6.43.14` / `latest`
// 都能被这条一眼抓住。§2.5-1 要求的是钉死，不是"大致这个版本"。
const 精确 = /^\d+\.\d+\.\d+$/;

let bad = 0;

for (const [name, ver] of Object.entries(a)) {
  if (!精确.test(ver)) {
    console.error(`⛔ ${A} 的 ${name} 不是精确版本号：${ver}`);
    bad = 1;
  }
}

for (const [name, verB] of Object.entries(b)) {
  if (!精确.test(verB)) {
    console.error(`⛔ ${B} 的 ${name} 不是精确版本号：${verB}`);
    bad = 1;
  }
  if (name in a && a[name] !== verB) {
    console.error(`⛔ ${name} 两份清单不一致：${A}=${a[name]} / ${B}=${verB}`);
    bad = 1;
  }
}

if (bad) {
  console.error("⛔ CM6 版本清单不一致（见上）。两份必须一起动（design/0012 §2.5-1）");
  process.exit(1);
}

const 共有 = Object.keys(b).filter((k) => k in a).length;
console.log(`✅ CM6 版本一致：两份清单共 ${共有} 项相同，且全部是精确版本号`);
