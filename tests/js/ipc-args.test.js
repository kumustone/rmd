// IPC 参数键的**契约判据**（`bugs/0088`）。
//
// ⭐ 为什么需要这一条：Tauri 2 的 `#[tauri::command]` 默认 `ArgumentCase::Camel`
//    ——后端形参 `doc_seq` / `last_file` 在 IPC 上叫 `docSeq` / `lastFile`。
//    前端若照着 Rust 的 snake_case 写键，**不会报错**：
//    `String` 参数回 `missing required key`，`Option` 参数静默变 `None`。
//    2026-11 之前的 `set_reading_progress` / `set_dir_session` / `open_link` 就是这样
//    "测试全绿、线上全废"（读写路径的测试直接调 Rust 函数，压根不经过 IPC 反序列化）。
//
// ⚠️ 判据是**源码级**的：从 `src-tauri/src/` 下的 `.rs` 读 `#[tauri::command]` 的形参，
//    从 `src/` 下的 `.js` 读 `T.call('cmd', { … })` 的**顶层**键，逐个对账。
//    ⛔ 只比顶层键：嵌套对象是 **serde 结构体字段**（如 `report.doc_children`），
//    那里默认保持 snake_case，与命令参数键是两回事——混在一起会造出假红。
//
// ⚠️ `T.call` 的第二个参数若是变量（不是对象字面量）⇒ 判不了，**明确报错**，
//    ⛔ 不许当成"通过"。扫描器找不到任何调用点时同理（防判据空转）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const RUST_ROOT = path.join(ROOT, 'src-tauri', 'src');
const JS_ROOT = path.join(ROOT, 'src');

/** 递归收集指定后缀的文件（排序保证报错稳定）。 */
function walk(dir, suffix) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push.apply(out, walk(p, suffix));
    else if (ent.name.endsWith(suffix)) out.push(p);
  }
  return out.sort();
}

/** 后端注入的参数（前端⛔ 不该也不能传）。 */
const INJECTED = [
  /^tauri::State\b/,
  /^tauri::AppHandle\b/,
  /^tauri::Window\b/,
  /^tauri::WebviewWindow\b/,
  /^tauri::App\b/,
  /^AppHandle\b/,
  /^Window\b/,
  /^WebviewWindow\b/,
];

/**
 * 从 `(` 处读一段配平的括号文本。只数 `()`；类型里的 `<>` 由调用方另行处理。
 * @returns {{text:string, end:number}|null}
 */
function balancedParens(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    // ⚠️ Rust 只认双引号：`tauri::State<'_, AppState>` 的 `'` 是生命周期，⛔ 不是字符字面量。
    if (c === '"') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return { text: src.slice(open, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * 把形参列表按**顶层逗号**切开（`<…>` / `[…]` / `(…)` 里的逗号不算）。
 */
function splitParams(text) {
  const inner = text.slice(1, -1);
  const parts = [];
  let buf = '';
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote) {
      buf += c;
      if (c === '\\') { buf += inner[i + 1] || ''; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    // ⚠️ 同上：`'` 是 Rust 的生命周期标记，⛔ 不当引号。
    if (c === '"') { quote = c; buf += c; continue; }
    if (c === '<') angle += 1;
    else if (c === '>') angle -= 1;
    else if (c === '(') paren += 1;
    else if (c === ')') paren -= 1;
    else if (c === '[') bracket += 1;
    else if (c === ']') bracket -= 1;
    if (c === ',' && angle === 0 && paren === 0 && bracket === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map(function (s) { return s.trim(); }).filter(Boolean);
}

/**
 * 扫 `src-tauri/src/` 下的 `.rs`：命令名 ⇒ 需要前端传的形参名（按出现顺序）。
 * @returns {Map<string, string[]>}
 */
function scanCommands() {
  const out = new Map();
  for (const file of walk(RUST_ROOT, '.rs')) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() !== '#[tauri::command]') continue;
      // 属性之后 8 行内必须出现 `fn name(`（`pub` / `async` 可选）。
      let found = null;
      for (let k = i + 1; k < Math.min(lines.length, i + 9); k += 1) {
        const m = lines[k].match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (m) { found = { name: m[1], open: k }; break; }
      }
      if (!found) continue; // 不是命令定义（理论上不会有）
      // 从 `fn name(` 的 `(` 起跨行读配平的形参表。
      let lineOffset = 0;
      for (let n = 0; n < found.open; n += 1) lineOffset += lines[n].length + 1;
      const fnIdx = src.indexOf('fn ' + found.name, lineOffset);
      assert.ok(fnIdx >= 0, `定位不到 ${path.relative(ROOT, file)}:${found.open + 1} 的函数头`);
      const openIdx = src.indexOf('(', fnIdx + ('fn ' + found.name).length);
      const sig = balancedParens(src, openIdx);
      assert.ok(sig, `读不出 ${path.relative(ROOT, file)}:${found.open + 1} 的形参表`);
      const params = [];
      for (const p of splitParams(sig.text)) {
        // 去掉可能的属性（`#[allow(...)] name: T`）后取名字。
        const m = p.match(/^(?:#\[[^\]]*\]\s*)?(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/);
        if (!m) continue;
        const name = m[1];
        const type = m[2].trim();
        if (name === 'self') continue;
        if (INJECTED.some(function (re) { return re.test(type); })) continue;
        params.push(name);
      }
      // 同名命令若出现两次（不同 feature 门控），以先出现的为准并合并检查。
      if (out.has(found.name)) {
        const prev = out.get(found.name);
        for (const p of params) if (prev.indexOf(p) < 0) prev.push(p);
      } else {
        out.set(found.name, params);
      }
      i = found.open;
    }
  }
  return out;
}

/** Tauri 2 默认的参数名口径：`doc_seq` ⇒ `docSeq`（`ArgumentCase::Camel`）。 */
function camel(name) {
  return name.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); });
}

function skipWs(src, i) {
  while (i < src.length && /\s/.test(src[i])) i += 1;
  return i;
}

/** 从 `{` 读配平的对象字面量（跳过字符串、行注释、块注释）。 */
function balancedBraces(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * 取出对象字面量的**顶层键**。
 * ⚠️ 只认 depth === 1 的 `key:` / 简写键；嵌套对象的字段（serde 结构体）不在此列。
 * @returns {{keys:string[], unknown:boolean}} `unknown` = 有展开（`...x`）⇒ 判不了。
 */
function topLevelKeys(objText) {
  const keys = [];
  let depth = 0;
  let quote = null;
  let unknown = false;
  let expectKey = false;
  for (let i = 0; i < objText.length; i += 1) {
    const c = objText[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && objText[i + 1] === '/') {
      const nl = objText.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (c === '/' && objText[i + 1] === '*') {
      const close = objText.indexOf('*/', i + 2);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth += 1;
      if (depth === 1) { expectKey = true; continue; }
    } else if (c === '}' || c === ')' || c === ']') {
      depth -= 1;
      continue;
    } else if (c === ',' && depth === 1) {
      expectKey = true;
      continue;
    }
    if (depth !== 1 || !expectKey) continue;
    if (objText.startsWith('...', i)) { unknown = true; expectKey = false; continue; }
    const m = objText.slice(i).match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[:,}])/);
    if (m) {
      keys.push(m[1]);
      expectKey = false;
      i += m[1].length - 1;
    }
  }
  return { keys: keys, unknown: unknown };
}

/**
 * 扫 `src/` 下的 `.js`：每一处 `T.call('cmd', { … })`。
 * @returns {{cmd:string, keys:string[]|null, where:string}[]} `keys=null` 表示第二个参数不是对象字面量
 */
function scanCalls() {
  const out = [];
  for (const file of walk(JS_ROOT, '.js')) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    let idx = -1;
    while ((idx = src.indexOf('T.call(', idx + 1)) >= 0) {
      // ⛔ 跳过注释里的提及（行首 `*` / `//` 之前的部分）。
      const lineStart = src.lastIndexOf('\n', idx) + 1;
      const prefix = src.slice(lineStart, idx);
      if (/^\s*(\*|\/\/)/.test(prefix)) continue;
      const lineNo = src.slice(0, idx).split('\n').length;
      let i = skipWs(src, idx + 'T.call('.length);
      const q = src[i];
      let cmd = null;
      if (q === "'" || q === '"') {
        const close = src.indexOf(q, i + 1);
        if (close > 0) cmd = src.slice(i + 1, close);
      }
      // ⛔ 命令名不是字符串字面量 ⇒ 判不了，记成 `null` 让对账显式报错。
      if (!cmd) {
        out.push({ cmd: null, keys: null, where: path.relative(ROOT, file) + ':' + lineNo });
        continue;
      }
      i = skipWs(src, src.indexOf(cmd, i) + cmd.length + 1);
      let keys = [];
      if (src[i] === ',') {
        i = skipWs(src, i + 1);
        if (src[i] === '{') {
          const obj = balancedBraces(src, i);
          const parsed = obj ? topLevelKeys(obj) : { keys: [], unknown: true };
          keys = parsed.unknown ? null : parsed.keys;
        } else {
          keys = null; // 变量 ⇒ 判不了
        }
      }
      out.push({
        cmd: cmd,
        keys: keys,
        where: path.relative(ROOT, file) + ':' + lineNo,
      });
    }
  }
  return out;
}

/**
 * 对账：Rust 的多词形参必须在前端以 camelCase 出现；snake_case 键必须不存在。
 * @param {{cmd:string, keys:string[]|null, where:string}[]} calls
 * @param {Map<string, string[]>} commands
 * @returns {string[]} 问题列表（空 = 通过）
 */
function checkCalls(calls, commands) {
  const problems = [];
  for (const call of calls) {
    if (call.cmd === null) {
      problems.push(call.where + '：`T.call` 的命令名不是字符串字面量，契约判不了（⛔ 不算通过）');
      continue;
    }
    const params = commands.get(call.cmd);
    if (!params) {
      problems.push(call.where + '：前端调了 `' + call.cmd + '`，但后端没有这条 `#[tauri::command]`');
      continue;
    }
    if (call.keys === null) {
      problems.push(call.where + '：`' + call.cmd + '` 的载荷不是对象字面量，契约判不了（⛔ 不算通过）');
      continue;
    }
    // 双向对账：后端形参 ⇒ 前端键（camelCase）；前端键 ⇒ 必须是某条形参。
    const allowed = params.slice();
    for (const p of params) {
      const c = camel(p);
      if (allowed.indexOf(c) < 0) allowed.push(c);
    }
    for (const key of call.keys) {
      if (allowed.indexOf(key) < 0) {
        problems.push(
          call.where + '：`' + call.cmd + '` 的载荷里有后端不认识的键 `' + key + '`' +
          '（形参：' + (params.join(', ') || '（无）') + '）'
        );
      }
    }
    for (const p of params) {
      if (p.indexOf('_') < 0) continue;
      const want = camel(p);
      if (call.keys.indexOf(want) < 0) {
        const hint = call.keys.indexOf(p) >= 0
          ? '（前端写的是 snake_case `' + p + '`）'
          : '';
        problems.push(
          call.where + '：`' + call.cmd + '` 缺 `' + want + '`（后端形参 `' + p + '`）' + hint
        );
      }
      if (call.keys.indexOf(p) >= 0) {
        problems.push(
          call.where + '：`' + call.cmd + '` 用了 snake_case 键 `' + p + '`，' +
          'Tauri 2 只认 `' + want + '`（`bugs/0088`）'
        );
      }
    }
  }
  return problems;
}

// ────────────────────────────────────────────────────────────────
// 判据 ①：扫描器自身不空转（命令表与三个历史靶子都在）
// ────────────────────────────────────────────────────────────────

test('IPC 契约：能从 Rust 源码读出 30+ 条命令，且三条历史靶子的多词形参在册', function () {
  const commands = scanCommands();
  assert.ok(commands.size >= 30, '只读到 ' + commands.size + ' 条命令，扫描器可能漂了');
  assert.deepStrictEqual(commands.get('set_reading_progress'), ['path', 'doc_seq', 'progress']);
  assert.deepStrictEqual(commands.get('open_link'), ['href', 'doc_seq']);
  assert.deepStrictEqual(commands.get('set_dir_session'), ['root', 'generation', 'last_file', 'expanded']);
  // 注入参数（state / app）不许混进前端契约。
  assert.deepStrictEqual(commands.get('get_session'), []);
});

test('IPC 契约：前端调用点扫得到，且三条历史靶子各自有调用', function () {
  const calls = scanCalls();
  assert.ok(calls.length >= 30, '只读到 ' + calls.length + ' 处 T.call，扫描器可能漂了');
  for (const cmd of ['set_reading_progress', 'set_dir_session', 'open_link']) {
    assert.ok(calls.some(function (c) { return c.cmd === cmd; }), '没扫到 `' + cmd + '` 的调用点');
  }
});

// ────────────────────────────────────────────────────────────────
// 判据 ②：全仓 `T.call` 的顶层键与 Rust 形参一一对应
// ────────────────────────────────────────────────────────────────

test('IPC 契约：所有 `T.call` 的多词参数都用 camelCase 键（`bugs/0088`）', function () {
  const problems = checkCalls(scanCalls(), scanCommands());
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});

// ────────────────────────────────────────────────────────────────
// 判据 ③：转换口径本身（含负对照，证明判据会红）
// ────────────────────────────────────────────────────────────────

test('IPC 契约：camelCase 口径与负对照', function () {
  assert.strictEqual(camel('doc_seq'), 'docSeq');
  assert.strictEqual(camel('last_file'), 'lastFile');
  assert.strictEqual(camel('sidebar_width'), 'sidebarWidth');
  assert.strictEqual(camel('path'), 'path');

  const commands = new Map([['set_reading_progress', ['path', 'doc_seq', 'progress']]]);

  // 正确写法 ⇒ 零问题。
  const ok = checkCalls(
    [{ cmd: 'set_reading_progress', keys: ['path', 'docSeq', 'progress'], where: 'ok' }],
    commands
  );
  assert.deepStrictEqual(ok, []);

  // ⛔ 负对照：写成 snake_case 必须红（且同时报"缺 docSeq"与"用了 doc_seq"）。
  const bad = checkCalls(
    [{ cmd: 'set_reading_progress', keys: ['path', 'doc_seq', 'progress'], where: 'mutant' }],
    commands
  );
  assert.ok(bad.some(function (p) { return /缺 `docSeq`/.test(p); }), '缺键没被报出来：\n' + bad.join('\n'));
  assert.ok(bad.some(function (p) { return /snake_case 键 `doc_seq`/.test(p); }), '错键没被报出来：\n' + bad.join('\n'));
});

// 顶层键提取的边界：嵌套对象字段（serde 结构体）⛔ 不是命令参数键。
test('IPC 契约：只比顶层键，嵌套结构体字段不参与', function () {
  const keys = topLevelKeys("{ report: { doc_children: 0, scroll_height: 1 }, other: 2 }");
  assert.deepStrictEqual(keys.keys, ['report', 'other']);
  assert.strictEqual(keys.unknown, false);
});
