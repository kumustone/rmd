// `design/0041` §7 的**源码级闸门**（`INV-DOCS-01/06` / `bugs/0002`）。
//
// ⚠️ 这四条判据的共同点：**违反了不会有任何一处报错**——
//   第二份遍历只会让"盘上变了"在两处各走各的；第二份自然序会比后端那份**看起来也对**，
//   只是顺序不同；少注册一处 ACL 是**静默拒**（`bugs/0002`）。
// ⇒ 只能靠扫源码。⭐ 每条都自带**反例自测**（给一段合成的违规源码，检查器必须判红）
//    —— 否则"永远绿"的闸门等于没有。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/** 递归收集某个目录下指定后缀的文件（相对仓库根）。 */
function walk(rel, exts, out) {
  const abs = path.join(ROOT, rel);
  let items;
  try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return out; }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const childRel = rel + '/' + it.name;
    if (it.isDirectory()) walk(childRel, exts, out);
    else if (exts.indexOf(path.extname(it.name)) >= 0) out.push(childRel);
  }
  return out;
}

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/**
 * 剥注释（行 ＋ 块）。
 * ⚠️ 把注释换成**等量空白**（保留换行）而不是删掉：这样行号与字符偏移都和原文一致，
 *    报错时印出来的 `文件:行` 才是能 `grep` 到的那一行。
 */
function strip(s) {
  const blank = function (m) { return m.replace(/[^\n]/g, ' '); };
  return s
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:/])\/\/[^\n]*/g, function (m, lead) { return lead + blank(m.slice(lead.length)); });
}

/**
 * 砍掉 `#[cfg(test)]` 之后的所有内容。
 * ⚠️ Rust 的单测模块里 `build_index(` 会出现在十几次——那是**夹具**，⛔ 不是第二个调用点。
 */
function rustNonTest(src) {
  const i = src.indexOf('#[cfg(test)]');
  return i < 0 ? src : src.slice(0, i);
}

// ── ① 共用一份索引：`build_index(` 的调用点恰好一处 ──────────────────────

/** 取某个偏移所在行的原文（用于报错时印出来）。 */
function lineAt(code, index) {
  const start = code.lastIndexOf('\n', index - 1) + 1;
  const end = code.indexOf('\n', index);
  return code.slice(start, end < 0 ? code.length : end).trim();
}

/**
 * 裸判据：一份 Rust 源码里 `build_index` 的**调用**位置（⛔ 不含定义、不含注释）。
 *
 * ⚠️ 不能只按行匹配 `build_index(`：rustfmt 在参数长的时候会把它折成
 *    `tree::build_index(\n    &grants,\n)`——按行找就**漏了**第二个调用点。
 * ⇒ 判据是"名字后面（跳过空白 / 换行）紧跟 `(`"。
 *
 * @returns {Array<{line:number, text:string}>}
 */
function buildIndexCalls(src) {
  const code = strip(rustNonTest(src));
  const out = [];
  const re = /build_index\b/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const after = code.slice(m.index + 'build_index'.length);
    if (!/^[ \t\r\n]*\(/.test(after)) continue;      // 不是调用（⛔ 也不是定义）
    const before = code.slice(Math.max(0, m.index - 24), m.index);
    if (/\bfn[ \t\r\n]+$/.test(before)) continue;     // `pub fn build_index(` ⇒ 定义
    out.push({ line: code.slice(0, m.index).split('\n').length, text: lineAt(code, m.index) });
  }
  return out;
}

test('裸判据自测：`build_index(` 的调用点被抓到，而定义处不算', function () {
  const fake = [
    'pub fn build_index(g: &G) -> R {',
    '    let idx = build_index(&g, &[])?;',
    '}',
  ].join('\n');
  const got = buildIndexCalls(fake);
  assert.strictEqual(got.length, 1, '检查器没抓到调用点 —— 它自己坏了');
  assert.strictEqual(got[0].line, 2);
});

test('裸判据自测：`#[cfg(test)]` 之后的夹具不算调用点', function () {
  const fake = [
    'fn real() { build_index(&g, &[]); }',
    '#[cfg(test)]',
    'mod tests { fn t() { build_index(&g, &[]); } }',
  ].join('\n');
  assert.strictEqual(buildIndexCalls(fake).length, 1);
});

test('裸判据自测：⛔ 被注释掉的、⛔ 折行的调用点都必须判对', function () {
  // 注释掉的**不算**（是说明，不是第二条路）；折行的**必须算**（rustfmt 真的会这么排）。
  const fake = [
    '// 曾经这里也调过一次 build_index(&g, &[])',
    '/* build_index(&g, &[]) */',
    'let a = tree::build_index(',
    '    &grants,',
    '    &ignore,',
    ')?;',
  ].join('\n');
  const got = buildIndexCalls(fake);
  assert.strictEqual(got.length, 1, '折行的那个调用点没被抓到 —— 判据按行找就会漏');
  assert.strictEqual(got[0].line, 3);
});

test('⭐ `src-tauri/src/**` 里 `build_index(` 的调用点**恰好一处**（`INV-DOCS-01`）', function () {
  const files = walk('src-tauri/src', ['.rs'], []);
  const hits = [];
  files.forEach(function (rel) {
    buildIndexCalls(read(rel)).forEach(function (h) {
      hits.push(rel + ':' + h.line + ' ' + h.text);
    });
  });
  assert.deepStrictEqual(hits.length, 1,
    '索引有两处构建入口（两份清单迟早不同步）：\n' + hits.join('\n'));
  assert.strictEqual(hits[0].split(':')[0], 'src-tauri/src/commands/fs.rs',
    '唯一调用点应当在后端那条共用入口（`obtain_index`）里，实际是：' + hits[0]);
});

// ── ② 自然序只有一份：前端⛔ 不排名字 ─────────────────────────────────────

/**
 * 裸判据：一份前端源码里**名字排序**的痕迹（剥注释后）。
 * ⚠️ 注释里提到 `localeCompare` 是**允许**的（`DocList.js` 的文件头就写着"⛔ 不再排一遍"）。
 */
function nameSortHits(src) {
  const code = strip(src);
  const out = [];
  const re = /localeCompare|Intl\s*\.\s*Collator/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const line = code.slice(0, m.index).split('\n').length;
    out.push({ line: line, text: m[0] });
  }
  return out;
}

test('裸判据自测：`localeCompare` / `Intl.Collator` 被抓到，注释里的不算', function () {
  const bad = [
    "// 这里⛔ 不用 localeCompare",
    "a.slice().sort(function (x, y) { return x.localeCompare(y); });",
    "const c = new Intl.Collator('zh');",
  ].join('\n');
  const got = nameSortHits(bad);
  assert.strictEqual(got.length, 2, '检查器没抓到名字排序 —— 它自己坏了');
  assert.deepStrictEqual(got.map(function (h) { return h.line; }), [2, 3]);
});

test('⭐ `src/**`（不含 `vendor/`）里没有第二处名字排序（`INV-DOCS-06`）', function () {
  const files = walk('src', ['.js'], []).filter(function (rel) {
    return rel.indexOf('/vendor/') < 0;
  });
  const hits = [];
  files.forEach(function (rel) {
    nameSortHits(read(rel)).forEach(function (h) {
      hits.push(rel + ':' + h.line + ' ' + h.text);
    });
  });
  assert.deepStrictEqual(hits, [],
    '前端又排了一遍名字 —— 后端 `fs/order.rs` 那一份是唯一实现，两份单独看都对、合起来必然漂移：\n'
    + hits.join('\n'));
});

/**
 * ⭐ 第三关：**`.sort(` 的文件白名单**。
 *
 * 光禁 `localeCompare` 不够：自己手写一个比较器（`a.path < b.path`）同样会造出第二份顺序。
 * ⇒ 这条闸门问的是"这个文件凭什么可以排序"，答案必须**写在这里**。
 * ⚠️ 白名单只收**与显示顺序无关**的那几处（深度 / 数值 / 源码区间）；
 *    新增一条要么并进后端，要么在这里写清理由——⛔ 不许悄悄加。
 */
const SORT_ALLOWED = {
  'src/services/sync.js': '源码区间按 (行, 列) 排（`design/0012` §11），与文件名无关',
  'src/services/measure.js': '数值排序（延迟样本），与名字无关',
  'src/services/treerefresh.js': '按**深度**排（浅的先展开），同深度才按路径定序——⚠️ 这不是显示顺序',
  'src/services/dirsession.js': '同上：按深度排展开计划（`design/0020`）',
  // ⚠️ `design/0052` U3 起隐藏区间来自**语法树遍历**，合并相邻区间前必须先按偏移排好
  //    （CM6 的 `Decoration.set(…, true)` 要求有序）。排的是**源码位置**，与名字/显示顺序无关。
  'src/live/decorations.js': '按源码偏移排隐藏区间（`design/0052` U3），与文件名无关',
};

/** 裸判据：出现 `.sort(` 的文件（剥注释后）。 */
function sortHits(rel, src) {
  return strip(src).split('\n').reduce(function (out, line, i) {
    if (/\.sort\s*\(/.test(line)) out.push(rel + ':' + (i + 1) + ' ' + line.trim());
    return out;
  }, []);
}

test('⭐ `.sort(` 只出现在白名单文件里（第二份顺序的另一种长相）', function () {
  const files = walk('src', ['.js'], []).filter(function (rel) {
    return rel.indexOf('/vendor/') < 0;
  });
  const bad = [];
  files.forEach(function (rel) {
    if (SORT_ALLOWED[rel]) return;
    sortHits(rel, read(rel)).forEach(function (h) { bad.push(h); });
  });
  assert.deepStrictEqual(bad, [],
    '这些文件里出现了排序，但不在白名单里 —— 要么并进后端，要么在 `SORT_ALLOWED` 里写清理由：\n'
    + bad.join('\n'));
});

test('白名单自测：给一个不在表里的文件，检查器必须判红', function () {
  const hits = sortHits('src/components/NewThing.js', 'xs.sort(function (a, b) { return a < b; });');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(SORT_ALLOWED['src/components/NewThing.js'], undefined);
});

test('⭐ 白名单里**没有过期条目**（每条都必须真的在排，否则它只是个橡皮图章）', function () {
  // ⚠️ 与 `i18n.test.js` 里"EXEMPT 每条都还存在"同一条纪律：
  //    条目一旦失效，闸门就从一个**判断**退化成一个**装饰**。
  Object.keys(SORT_ALLOWED).forEach(function (rel) {
    assert.ok(sortHits(rel, read(rel)).length > 0,
      '白名单里的 ' + rel + ' 现在根本没有 `.sort(` —— 删掉这一条，别让它替将来的排序背书');
  });
});

test('白名单里**没有** `DocList.js` / `doclists.js` / `FileTree.js`（列表⛔ 不排序）', function () {
  ['src/components/DocList.js', 'src/services/doclists.js', 'src/components/FileTree.js']
    .forEach(function (rel) {
      assert.strictEqual(SORT_ALLOWED[rel], undefined, rel + ' 不该在白名单里');
      assert.deepStrictEqual(sortHits(rel, read(rel)), [], rel + ' 里出现了排序');
    });
});

// ── ④ 新命令的三处注册（`bugs/0002`：漏一处是**静默拒**）─────────────────

const COMMANDS = ['list_documents', 'set_sidebar_file_view'];

function kebab(s) { return s.replace(/_/g, '-'); }

test('⭐ 两个新命令在**三处清单**里都在（`bugs/0002` 的静默拒）', function () {
  // ⚠️ 只在**代码**里找：注释里提到命令名是**说明**，⛔ 不构成注册
  //    （`build.rs` 那段注释就写着 `set_appearance` 的历史）。
  const buildRs = strip(read('src-tauri/build.rs'));
  const guiRs = strip(read('src-tauri/src/gui/mod.rs'));
  const caps = JSON.parse(read('src-tauri/capabilities/default.json'));
  COMMANDS.forEach(function (cmd) {
    assert.ok(new RegExp('"' + cmd + '"').test(buildRs),
      '⛔ `build.rs` 的 `App::commands(&[…])` 里没有 `' + cmd + '`（少了它 ACL 没有对应权限可给 ⇒ 静默拒）');
    assert.ok(new RegExp('\\b' + cmd + '\\b').test(guiRs),
      '⛔ `gui/mod.rs` 的 `generate_handler!` 里没有 `' + cmd + '`');
    assert.ok(JSON.stringify(caps).indexOf('"allow-' + kebab(cmd) + '"') >= 0,
      '⛔ `capabilities/default.json` 里没有 `allow-' + kebab(cmd) + '`（症状是**静默拒绝**，`bugs/0002`）');
  });
});

test('三处清单自测：注释里写命令名**不算**注册', function () {
  const fake = '// 曾经漏过 "set_sidebar_file_view"\nfn f() {}\n';
  assert.strictEqual(new RegExp('"set_sidebar_file_view"').test(strip(fake)), false,
    '注释没被剥掉 —— 那么"文件里搜得到这个名字"随时可能是一条注释');
});
