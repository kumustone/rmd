// 离屏探针**页面副本的脚本清单**的静态审计 —— 2026-11-08（`bugs/0095`）。
//
// ⭐ 为什么需要这一条：`tools/wkwebview-probe/*-probe.sh` 的做法是「把产品脚本**拷进**一个
//    临时页面，再按顺序挂 `<script>`」。产品每加一个**加载期取值**的依赖，探针就可能漏拷，
//    而漏拷的表现**不是编译错误**：那个常量是 `undefined`，只有真正用到时才炸，
//    或者悄悄降级（`I18N ? I18N.t : 恒等 t`）⇒ 探针跑出来的"红/绿"都不再可信。
//
// ⭐ 真踩过两次（第二次是 `bugs/0095` 的 2026-11-05）：
//    ① `probe-dir-session` 少拷 `diskevents / treerefresh / clipboard` ⇒ 整棵树建不起来（9/10 红）；
//    ② `probe-tree-menu` 少拷 `diskevents.js` ⇒ 28/32 红。
//    两次都是**产品演进后探针没跟上**，而发现代价是「跑十几分钟 + 人读输出」。
//    ⇒ 这些在源码里就能判，⛔ 不该用跑一次探针的代价换。
//
// ⚠️ 判据只读**源码形态**，⛔ 不执行 shell、⛔ 不跑探针：
//    · `cp "$VAR" "$dir/<页面名>"` 给出「页面文件 → 产品文件」的映射；
//    · 页面 HTML 里的 `<script src="…">` 给出**真实加载顺序**（经典脚本按顺序执行）；
//    · 产品脚本里 `(window.rmd || (window.rmd = {})).NAME = …` 给出**定义者**；
//      凡 `window.rmd.NAME` 的取值，定义者必须在页里、且排在取值者之前。
// ⚠️ 软依赖（有恒等兜底、故意不拷）必须**显式登记**在下面的 `SOFT_DEPS`，并在探针脚本里
//    有一句注释说明——⛔ 不许靠"反正不炸"默默放过，否则下一条漏拷也会这样被放过。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PROBE_DIR = path.join(ROOT, 'tools', 'wkwebview-probe');

/**
 * 软的 `window.rmd.*` 依赖：允许**不拷**，但必须写明兜底与适用范围。
 * ⚠️ 键是 `window.rmd.<NAME>` 里的 `<NAME>`；`probe` 限定是哪份探针。
 */
const SOFT_DEPS = [
  {
    name: 'i18n',
    probe: 'dir-session-probe.sh',
    why: 'FileTree.js / search.js 对它是恒等兜底（`I18N ? I18N.t : 原样返回 key`），' +
      'tauri.js 取不到就 `return null`；本探针的判据不依赖任何译文。',
  },
];

/** 剥掉注释（块注释 + 独占一行的 `//`），避免注释里的 `window.rmd.x` 被当成真取值。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 读 `^NAME="value"` 形式的变量表（探针脚本头部全是这种写法）。 */
function readVars(src) {
  const vars = {};
  const re = /^([A-Z0-9_]+)="([^"]+)"/gm;
  let m;
  while ((m = re.exec(src))) vars[m[1]] = m[2];
  return vars;
}

/** 展开 `$ROOT` / `$HERE`（探针脚本里只有这两个前缀变量）。 */
function expand(value, root, here) {
  return value.split('$ROOT').join(root).split('$HERE').join(here);
}

/**
 * 审计一份探针脚本的页面组装。
 * @param {string} src 探针脚本源码
 * @param {string} root 仓库根
 * @param {string} here 探针目录
 * @returns {{pageMap:Object<string,string>, order:string[],
 *   missingFile:string[], notLoaded:string[], unknownRefs:string[], orderViolations:string[]}}
 */
function checkProbe(src, root, here) {
  const vars = readVars(src);
  const pageMap = {};
  const cpRe = /cp\s+"\$([A-Z0-9_]+)"\s+"\$dir\/([^"]+)"/g;
  let m;
  while ((m = cpRe.exec(src))) {
    const raw = expand(vars[m[1]] || '', root, here);
    pageMap[m[2]] = path.isAbsolute(raw) ? raw : path.join(root, raw);
  }

  const order = [];
  const tagRe = /<script\s+src="([^"]+)"/g;
  while ((m = tagRe.exec(src))) order.push(m[1]);

  // ① 页里的每个 `<script>` 都要有来源；每个拷进去的文件都要被挂上。
  const missingFile = order.filter(function (p) { return !pageMap[p]; });
  const notLoaded = Object.keys(pageMap).filter(function (p) { return order.indexOf(p) < 0; });

  // ② 读页面里每一份脚本（读不到的文件单独报，⛔ 不静默当成空）。
  const texts = {};
  for (const page of order) {
    const full = pageMap[page];
    if (!full) continue;
    if (!fs.existsSync(full)) { missingFile.push(page + ' → ' + full); continue; }
    texts[page] = stripComments(fs.readFileSync(full, 'utf8'));
  }

  // ③ 定义者：`(window.rmd || (window.rmd = {})).NAME = api`。
  const defines = {};
  for (const page of Object.keys(texts)) {
    const re = /\(window\.rmd \|\| \(window\.rmd = \{\}\)\)\.(\w+)/g;
    let g;
    while ((g = re.exec(texts[page]))) defines[g[1]] = page;
  }

  // ④ 取值：定义者必须在页里、且排在前面。
  const at = {};
  order.forEach(function (p, i) { at[p] = i; });
  const unknownRefs = [];
  const orderViolations = [];
  const takeRe = /window\.rmd\.(\w+)/g;
  for (const page of Object.keys(texts)) {
    let g;
    while ((g = takeRe.exec(texts[page]))) {
      const name = g[1];
      // ⚠️ `window.rmd = {}` 那种写法本身也会被上面这条正则错过；这里只处理取 `window.rmd.NAME`。
      if (name === 'rmd') continue;
      const def = defines[name];
      if (!def) {
        if (!unknownRefs.some(function (u) { return u.name === name && u.from === page; })) {
          unknownRefs.push({ name: name, from: page });
        }
        continue;
      }
      if (at[def] > at[page]) orderViolations.push(page + ' 排在 ' + def + ' 之前却取 window.rmd.' + name);
    }
  }

  return { pageMap: pageMap, order: order, missingFile: missingFile,
    notLoaded: notLoaded, unknownRefs: unknownRefs, orderViolations: orderViolations };
}

/** 找出所有「用 `cp "$VAR" "$dir/..."` 组装页面」的探针脚本。 */
function probeScripts() {
  return fs.readdirSync(PROBE_DIR).filter(function (n) {
    if (!/-probe\.sh$/.test(n)) return false;
    const src = fs.readFileSync(path.join(PROBE_DIR, n), 'utf8');
    return /cp\s+"\$[A-Z0-9_]+"\s+"\$dir\//.test(src);
  }).sort();
}

test('探针页面脚本清单_不漏拷_顺序正确', function () {
  const names = probeScripts();
  // 反面：扫描器不空转。当前至少三份（dir-session / tree-menu / favorites-rootheader）。
  assert.ok(names.length >= 3, '没扫到组装页面的探针脚本，正则或目录写错了？' + names.join(','));

  const bad = [];
  for (const name of names) {
    const src = fs.readFileSync(path.join(PROBE_DIR, name), 'utf8');
    const r = checkProbe(src, ROOT, PROBE_DIR);

    if (!r.order.length) bad.push(name + '：页面里一个 <script src> 都没扫到');
    if (!Object.keys(r.pageMap).length) bad.push(name + '：一条 cp 行都没扫到');

    if (r.missingFile.length) {
      bad.push(name + '：页里的脚本没有来源 / 来源不存在 ⇒ ' + r.missingFile.join('，'));
    }
    if (r.notLoaded.length) {
      bad.push(name + '：拷进去却没挂 <script> ⇒ ' + r.notLoaded.join('，') +
        '（页面里永远拿不到它，等于没拷）');
    }

    const soft = SOFT_DEPS.filter(function (s) { return s.probe === name; });
    for (const u of r.unknownRefs) {
      const s = soft.find(function (it) { return it.name === u.name; });
      if (s) continue;
      bad.push(name + '：' + u.from + ' 取了无人定义的 window.rmd.' + u.name);
    }
    for (const v of r.orderViolations) bad.push(name + '：' + v);
  }

  assert.deepStrictEqual(bad, [],
    '探针页面与产品脚本清单脱节（经典脚本按顺序执行、依赖是加载期取值）：\n' + bad.join('\n'));
});

test('探针页面脚本清单_软依赖必须有兜底说明', function () {
  // ⚠️ 这条防的是「把漏拷登记成软依赖」这种作弊：登记项必须在对应探针脚本里留下注释说明，
  //    并且拿掉的兜底必须是**产品里真实存在**的那一种。
  const bad = [];
  for (const s of SOFT_DEPS) {
    const file = path.join(PROBE_DIR, s.probe);
    assert.ok(fs.existsSync(file), '软依赖登记的探针不存在：' + s.probe);
    const src = fs.readFileSync(file, 'utf8');
    if (src.indexOf(s.name) < 0) bad.push(s.probe + ' 没提到软依赖 ' + s.name);
    if (!/兜底/.test(src)) bad.push(s.probe + ' 没说明 ' + s.name + ' 的兜底');
    if (!s.why) bad.push('软依赖 ' + s.name + ' 没写 why');
  }
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

test('探针页面脚本清单_审计器自身有区分力', function () {
  // ⚠️ 变异自测：合成一份探针脚本，把四种坏法各造一次 —— 审计器必须逐条报出来。
  //    ⛔ 没有这一组，上面那条判据可能只是"什么都没检查"（`tests.md`：没做过变异测试的断言不算数）。
  const root = '/R';
  const here = '/R/tools/wkwebview-probe';
  const mk = function (opts) {
    const lines = [];
    lines.push('ROOT="$ROOT_ROOT"');
    lines.push('HERE="$ROOT/tools/wkwebview-probe"');
    lines.push('A="$ROOT/a.js"');
    lines.push('B="$ROOT/b.js"');
    lines.push('C="$ROOT/c.js"');
    lines.push('H="$HERE/h.js"');
    lines.push('build_page() {');
    lines.push('  cp "$A" "$dir/a.js"');
    lines.push('  cp "$B" "$dir/b.js"');
    if (!opts.dropCp) lines.push('  cp "$C" "$dir/c.js"');
    lines.push('  cp "$H" "$dir/h.js"');
    lines.push('  cat > "$dir/index.html" <<\'HTML\'');
    lines.push('<script src="a.js"></script>');
    if (opts.wrongOrder) {
      lines.push('<script src="c.js"></script>');
      lines.push('<script src="b.js"></script>');
    } else {
      lines.push('<script src="b.js"></script>');
      lines.push('<script src="c.js"></script>');
    }
    if (!opts.dropTag) lines.push('<script src="h.js"></script>');
    lines.push('<script src="ghost.js"></script>');
    lines.push('HTML');
    lines.push('}');
    return lines.join('\n');
  };

  // 全绿基线：a 定义 x；b 定义 y；c 定义 z，但**取 a 的 x**；h 取 b 的 y。
  const files = {
    '/R/a.js': '(window.rmd || (window.rmd = {})).x = 1;',
    '/R/b.js': '(window.rmd || (window.rmd = {})).y = 2;',
    '/R/c.js': 'const z = window.rmd.y; (window.rmd || (window.rmd = {})).z = 3;',
    '/R/tools/wkwebview-probe/h.js': 'const q = window.rmd.x;',
  };
  const origExists = fs.existsSync;
  const origRead = fs.readFileSync;
  fs.existsSync = function (p) { return Object.prototype.hasOwnProperty.call(files, p) || p === '/R/ghost.js'; };
  fs.readFileSync = function (p) {
    if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
    throw new Error('unexpected read ' + p);
  };
  try {
    // 基线：只有 `ghost.js` 没有来源 ⇒ 恰好命中 missingFile 一项。
    const ok = checkProbe(mk({}), root, here);
    assert.deepStrictEqual(ok.orderViolations, [], '基线不该有顺序违规');
    assert.deepStrictEqual(ok.notLoaded, [], '基线不该有未挂载的拷贝');
    assert.deepStrictEqual(ok.missingFile, ['ghost.js'], '基线应只报 ghost.js 没有来源');

    // ① 少 cp 一个文件却仍挂 `<script>` ⇒ 那个 script 没有来源。
    //    ⚠️ 这正是 `bugs/0095` 的第一种形态：页面引用了产品脚本，`build_page` 却没拷它。
    const noCp = checkProbe(mk({ dropCp: true }), root, here);
    assert.deepStrictEqual(noCp.missingFile.sort(), ['c.js', 'ghost.js'],
      '少拷 c.js 必须报"页里的脚本没有来源"');

    // ② 少挂一个 `<script>` ⇒ 拷贝了却永远拿不到。
    const noTag = checkProbe(mk({ dropTag: true }), root, here);
    assert.deepStrictEqual(noTag.notLoaded, ['h.js'], '少挂 h.js 必须报 notLoaded');

    // ③ 顺序反了 ⇒ c 取 y 时 b 还没定义。
    const wrong = checkProbe(mk({ wrongOrder: true }), root, here);
    assert.ok(wrong.orderViolations.length > 0, 'c 排在 b 之前却取 window.rmd.y，必须报顺序违规');
    assert.ok(wrong.orderViolations[0].indexOf('c.js') >= 0, '顺序违规应点名 c.js');

    // ④ 取了没人定义的 window.rmd.NAME ⇒ unknownRefs 命中（软依赖放行是另一条判据的事）。
    files['/R/c.js'] = 'const z = window.rmd.missing; (window.rmd || (window.rmd = {})).z = 3;';
    const unknown = checkProbe(mk({}), root, here);
    assert.ok(unknown.unknownRefs.some(function (u) { return u.name === 'missing'; }),
      '取用无人定义的 window.rmd.missing 必须被报出来');
  } finally {
    fs.existsSync = origExists;
    fs.readFileSync = origRead;
  }
});
