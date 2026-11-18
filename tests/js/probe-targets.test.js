// 探针变异靶子的**静态审计** —— 2026-11-02「举一反三」。
//
// ⭐ 为什么需要这一条：`apply_mutation`（五份探针脚本各一份实现）要求目标串在**页面副本**里
//    **恰好命中 1 次**，否则整轮以退出码 4 结束。它的两种坏法都很贵：
//    ① **靶子漂开**（产品代码重构、变量改名）⇒ 命中 0 ⇒ 整轮作废。真踩过：
//       2026-11-02 `bugs/0060` 第二版把 `preeditText` 改名 `preeditShown`，`M34` 当场 `HITS=0`，
//       **跑了十几分钟才发现**，而屏幕上看起来像"判据红了"。
//    ② **靶子变宽**（同一段代码被复制成两处）⇒ 命中 2 ⇒ 变异改了两处，语义变成另一件事。
//    ⚠️ 更坏的一种：**守卫本身被改弱**（`if hits != 1` 删掉）⇒ 变异什么都没做，
//       `cksum` 不变 → 那条 `apply_mutation` 直接退 4；但如果连 `cksum` 一起没了，
//       整条变异**静默失效**，而"变异通过"会被读成"判据承重"——`tests.md` 明令这不算数。
//    ⇒ 这些都在**源码里就能判**，⛔ 不该用跑一次探针的代价换。
//
// ⚠️ 判据只认**行首**的 `apply_mutation`（注释里到处都在提这个名字）；
//    路径映射从各脚本 `build_page` 的 `cp` 行里读，⛔ 不硬编码文件名表——
//    新增一份探针/换一次页面组装，这条判据自动覆盖到。
// ⚠️ 变异自测在最后：把靶子/映射/守卫各写坏一次，必须变红。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const TOOLS = path.join(ROOT, 'tools');

/** 递归找出 `tools/` 下所有 `.sh`（⛔ 只看这一处：产品源码里不该有探针脚本）。 */
function findShellScripts(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    // ⚠️ 点开头的是探针的**工作目录**（`.lb-work` / `.cg-work` …）：它们由探针自己
    //    `rm -rf` 再重建 ⇒ 扫描时目录可能**中途消失**（`ENOENT`），或者扫到页面副本里
    //    从没被审计过的 `apply_mutation`（2026-11-04 实测：与 `block-probe.sh` 并行跑
    //    `make test-js` 时这条判据当场炸成 ENOENT）。⛔ 那不是被测对象。
    if (ent.isDirectory()) {
      if (ent.name.charAt(0) === '.') continue;
      out.push.apply(out, findShellScripts(p));
    } else if (ent.name.slice(-3) === '.sh') out.push(p);
  }
  return out.sort();
}

/** 读成 `{file, rel, src}`；`rel` 用于报错（相对于仓库根，`.sh` 文件名一眼能认）。 */
function readScript(file) {
  return { file: file, rel: path.relative(ROOT, file), src: fs.readFileSync(file, 'utf8') };
}

/**
 * 从 `apply_mutation <path> <old> <new>` 的参数位置起，读三个 **shell 单/双引号串**。
 * ⚠️ 参数里可以带真实换行（`old` 常是一整段多行代码），也可以带 `\"`；反斜杠续行要跳过。
 * ⛔ 不引 shell 来解析（那等于把探针脚本执行一遍）。
 * @returns {{path:string, old:string, next:string, end:number}|null}
 */
function parseCallArgs(src, i) {
  const args = [];
  while (args.length < 3) {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\\' || src[i] === '\n')) i += 1;
    const q = src[i];
    if (q !== '"' && q !== "'") return null;
    i += 1;
    let buf = '';
    while (i < src.length && src[i] !== q) {
      if (q === '"' && src[i] === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (q === '"' && src[i] === '\\' && src[i + 1] === '"') { buf += '"'; i += 2; continue; }
      buf += src[i];
      i += 1;
    }
    if (i >= src.length) return null;
    i += 1;
    args.push(buf);
  }
  return { path: args[0], old: args[1], next: args[2], end: i };
}

/** 把脚本里每一处 `apply_mutation` 调用读出来（`line` 从 1 起，报错用）。 */
function collectCalls(script) {
  const calls = [];
  const re = /^[ \t]*apply_mutation /gm;
  let m;
  while ((m = re.exec(script.src)) !== null) {
    const at = parseCallArgs(script.src, m.index + m[0].length);
    const line = script.src.slice(0, m.index).split('\n').length;
    if (!at) {
      calls.push({ rel: script.rel, line: line, broken: true });
      continue;
    }
    calls.push({ rel: script.rel, line: line, path: at.path, old: at.old, broken: false });
  }
  return calls;
}

/** `$ROOT` / `$HERE` / `$SRC` / `$SRCDIR` 替换成真实绝对路径。 */
function resolveVars(script, value) {
  return value
    .replace(/\$ROOT/g, ROOT)
    .replace(/\$HERE/g, path.dirname(script.file))
    .replace(/\$SRCDIR/g, path.join(ROOT, 'src'))
    .replace(/\$SRC/g, path.join(ROOT, 'src'));
}

/**
 * 页面里的相对名 → 源码绝对路径。
 * ⭐ 映射从脚本自己的 `build_page` 里读，两族都要认：
 *    ① `cp -R "$SRC/." "$dir/"` ⇒ 页面名**就是** `src/` 下的相对路径；
 *    ② `cp "$VAR" "$dir/name.js"` ⇒ 按 `VAR="…/src/…/X.js"` 那个赋值解析。
 * @returns {{file:string|null, why:string}}
 */
function mapPageFile(script, rel) {
  const defs = {};
  const defRe = /^([A-Z_0-9]+)="([^"]+)"/gm;
  let d;
  while ((d = defRe.exec(script.src)) !== null) defs[d[1]] = d[2];

  const flat = {};
  const cpRe = /^[ \t]*cp[ \t]+"\$([A-Z_0-9]+)"[ \t]+"\$dir\/([^"]+)"/gm;
  let c;
  while ((c = cpRe.exec(script.src)) !== null) {
    if (defs[c[1]]) flat[c[2]] = resolveVars(script, defs[c[1]]);
  }
  if (flat[rel]) return { file: flat[rel], why: '' };

  const passthru = /cp -R "\$(SRC|SRCDIR)\/\." "\$dir\/"/.test(script.src);
  if (passthru) return { file: path.join(ROOT, 'src', rel), why: '' };
  return {
    file: null,
    why: '`' + rel + '` 既不在 `cp "$VAR" "$dir/…"` 的映射表里，脚本也没整目录搬 `src/`'
      + ' ⇒ 判据不知道该去哪个源码里数命中',
  };
}

/** 守卫本体：`if hits != 1:` ＋ `sys.exit(4)` ＋ 改前改后 `cksum` 比对，缺一条就静默失效。 */
function guardBody(script) {
  const head = script.src.indexOf('apply_mutation() {');
  if (head < 0) return '';
  const tail = script.src.indexOf('\n}\n', head);
  return tail < 0 ? script.src.slice(head) : script.src.slice(head, tail);
}

/**
 * 审计一份脚本集合（`{file, rel, src}`）。
 * @returns {string[]} 问题清单（空 = 全过）
 */
function audit(scripts) {
  const bad = [];
  scripts.forEach(function (script) {
    const calls = collectCalls(script);
    if (!calls.length) return;
    const guard = guardBody(script);
    if (!guard) {
      bad.push(script.rel + ' 里找不到 `apply_mutation() {` 的实现');
    } else {
      if (guard.indexOf('if hits != 1:') < 0) {
        bad.push(script.rel + ' 的 `apply_mutation` 没有"命中必须恰好 1 次"的守卫'
          + ' ⇒ 靶子漂开时变异**什么都不改**，而判据照样绿（`tests.md`：这不算承重证据）');
      }
      if (guard.indexOf('sys.exit(4)') < 0) {
        bad.push(script.rel + ' 的 `apply_mutation` 命中数不对时不退 4 ⇒ 整轮会带着"没施加"的变异跑完');
      }
      if (guard.indexOf('cksum') < 0) {
        bad.push(script.rel + ' 的 `apply_mutation` 没有 `cksum` 前后比对 ⇒ "改法等价"与"改到了"分不开');
      }
    }
    calls.forEach(function (call) {
      const where = script.rel + ':' + call.line;
      if (call.broken) {
        bad.push(where + ' 的 `apply_mutation` 参数读不出来（引号没闭合？）');
        return;
      }
      const mapped = mapPageFile(script, call.path.indexOf('/') >= 0 ? call.path.split('/').slice(1).join('/') : call.path);
      if (!mapped.file) {
        bad.push(where + '：' + mapped.why);
        return;
      }
      if (!fs.existsSync(mapped.file)) {
        bad.push(where + ' 的靶子文件不存在：' + path.relative(ROOT, mapped.file)
          + '（映射自 `' + call.path + '`）');
        return;
      }
      if (!call.old) {
        bad.push(where + ' 的目标串是**空的** —— `apply_mutation` 会把它当成"处处命中"，'
          + '`HITS` 是一个无意义的数；这条变异什么都证明不了');
        return;
      }
      const txt = fs.readFileSync(mapped.file, 'utf8');
      let n = 0;
      let at = txt.indexOf(call.old);
      while (at >= 0) { n += 1; at = txt.indexOf(call.old, at + call.old.length); }
      if (n !== 1) {
        bad.push(where + ' 的靶子在 ' + path.relative(ROOT, mapped.file) + ' 里命中 **' + n + '** 次'
          + '（`apply_mutation` 要求恰好 1）⇒ 跑起来会 `HITS=' + n + '` 退 4，整轮数字作废。'
          + ' 目标串现在以 `' + JSON.stringify(call.old.slice(0, 60)) + '` 开头');
      }
    });
  });
  return bad;
}

function realScripts() {
  return findShellScripts(TOOLS)
    .filter(function (f) { return /^[ \t]*apply_mutation /m.test(fs.readFileSync(f, 'utf8')); })
    .map(readScript);
}

test('⭐ 探针的每一处变异靶子都在产品源码里**恰好命中 1 次**', function () {
  const scripts = realScripts();
  assert.ok(scripts.length >= 5,
    '只找到 ' + scripts.length + ' 份带 apply_mutation 的探针脚本 —— 判据自己没扫到东西');
  const bad = audit(scripts);
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

test('⭐ 变异自测：靶子漂开 / 靶子变宽 / 映射丢了 / 守卫被改弱，各必须变红', function () {
  const scripts = realScripts();
  assert.deepStrictEqual(audit(scripts), [], '基线必须先全绿，否则下面分不清是谁的红');

  // 挑一处真实调用当靶子（⛔ 不硬编码行号：脚本改动不该让自测跟着漂）
  const host = scripts.filter(function (s) {
    return collectCalls(s).some(function (c) { return !c.broken; });
  })[0];
  assert.ok(host, '找不到任何一处可用的 apply_mutation 调用');
  const sample = collectCalls(host).filter(function (c) { return !c.broken; })[0];

  /** 用同一份脚本源替换一处，得到"写坏的副本"。 */
  function broken(from, to) {
    const src = host.src;
    assert.strictEqual(src.split(from).length - 1, 1,
      '自测的靶子在 ' + host.rel + ' 里必须恰好 1 处：' + JSON.stringify(from.slice(0, 50)));
    return [{ file: host.file, rel: host.rel, src: src.replace(from, to) }];
  }

  // ① 靶子漂开（产品代码改名之后最常见的那种）
  const drifted = audit(broken(sample.old, '__靶子已经漂开了__'));
  assert.ok(drifted.some(function (x) { return x.indexOf('命中 **0** 次') >= 0; }), drifted.join('\n'));

  // ② 靶子变宽（同一段代码被复制成两处 ⇒ 变异改了两件事）
  //    ⭐ 从**真实源码**里挑一行本来就有两处的，⛔ 不构造假串——否则测的是自测自己。
  const mappedFile = mapPageFile(host, sample.path.split('/').slice(1).join('/')).file;
  const realLines = fs.readFileSync(mappedFile, 'utf8').split('\n');
  let twice = '';
  for (const ln of realLines) {
    if (ln.trim().length < 3) continue;
    if (realLines.filter(function (x) { return x === ln; }).length >= 2) { twice = ln; break; }
  }
  assert.ok(twice, '自测找不到"在源码里出现两次"的行 —— 换个靶子文件');
  const widened = audit(broken(sample.old, twice));
  assert.ok(
    widened.some(function (x) { return /命中 \*\*[2-9]\d*\*\* 次/.test(x); }),
    widened.join('\n')
  );

  // ③ 页面文件映射不上（新探针把某份源码另起了一个名字）
  const unmapped = audit(broken(sample.path, '$P1/no-such-file.js'));
  assert.ok(unmapped.some(function (x) { return x.indexOf('靶子文件不存在') >= 0; }), unmapped.join('\n'));

  // ④ 守卫被改弱：命中数不对时不再退 4 ⇒ "变异没施加"会被读成"判据通过"
  const weak = audit(broken('if hits != 1:', 'if hits > 9:'));
  assert.ok(weak.some(function (x) { return x.indexOf('命中必须恰好 1 次') >= 0; }), weak.join('\n'));

  // ⑤ 空目标串：`indexOf('')` 处处命中，这一族曾经把自测自己挂死（`at += 0` 死循环）
  const empty = audit(broken(sample.old, ''));
  assert.ok(empty.some(function (x) { return x.indexOf('目标串是**空的**') >= 0; }), empty.join('\n'));
});
