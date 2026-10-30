'use strict';

// `design/0047` §7.2 **第 7 条**：`make probe-live-commit` 的 **JS 半**。
//
// # 它补的是哪一块（⚠️ 与另两份别混）
//
// | 谁 | 验什么 | 在哪 |
// |---|---|---|
// | `make fidelity`（0e） | **Rust** 侧：打开→改字→保存，7 类信封逐字节 | `commands/edit.rs` |
// | `make probe-live-step0` | 步骤 0 的**可运行证据**（块表 / 载荷 / 信封往返） | `live-probe --envelope` 等 |
// | ⭐ 本文件 | **JS 行模型**的提交是否**逐字符**无损（同一批真实样本） | 这里 |
//
// 为什么非得单独一道：`src/live/model.js` 的 `[from,to)` 换段一旦 off-by-one，
// 表现是"用户在块尾敲一个字，下一块的第一个字没了"——而 `make test-js` 里那批
// `live-model.test.js` 用的是**造出来的**短串，撞不到"块边界贴着文件末尾 / 文件没有尾换行 /
// 空文件 / `Eol::Other`"这几种真实形状。⇒ 用 **Rust 出的真实归一化样本**再压一遍。
//
// # ⚠️ 两份实现各归各，⛔ 不互相抄
//
// - 样本的**归一化**（去 BOM、统一行尾）在 `document/envelope.rs`，由 `live-probe --commit-json` 出；
//   ⛔ JS 侧**不再归一化一次**（那就是第二份实现）。
// - 块行区间来自 AST `sourcepos`（`blocks.rs` 那份遍历），⛔ 不是猜的。
// - 被验的是**产品那两份**：`src/live/model.js` / `src/live/blocks.js`（`require` 进来的原件）。
//
// # 运行方式
//
// ```bash
// make probe-live-commit          # ✅ 只有这个入口（它会先跑 Rust 出夹具）
// ```
// ⚠️ 单独跑本文件时**必须**给 `RMD_COMMIT_JSON`：
// 没有夹具就**只报 skip**——⛔ 别把"看空"当成"通过"（`tests.md` 的那个坑）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const MODEL_PATH = path.join(ROOT, 'src', 'live', 'model.js');
const BLOCKS_PATH = path.join(ROOT, 'src', 'live', 'blocks.js');

/** 产品原件（⚠️ 变异自测会另编译一份，基线用这一份）。 */
const M0 = require(MODEL_PATH);
const B0 = require(BLOCKS_PATH);

/**
 * 种类名表（⭐ 与 Rust `blocks::KIND_NAMES` **同序**）。
 *
 * ⚠️ 这里**不手抄十行**：直接用产品 `SHAPES` 的键序——它已经是那个下标表，
 * 手抄一份就是第二份真值（Rust 改名时它不会报错，只会让本闸门恒绿）。
 */
const KINDS = Object.keys(B0.SHAPES);

const FIXTURE = process.env.RMD_COMMIT_JSON || '';

/** 行数组（⚠️ 只借 JS 原生 `split`，⛔ 不调产品函数——期望值必须独立于被测实现）。 */
function linesOf(text) {
  return String(text).split('\n');
}

/**
 * 线格式（`blocks.rs::to_wire` 的形状）——`{line_count, block_kinds, blocks}`。
 *
 * ⚠️ `editable` 在这里按 `Eol::Other ⇒ 0` 生成（`design/0047` §2.4-5：整篇不可编辑）。
 * 真正的**块族白名单**在 Rust（`blocks.rs::inline_editable`，它有自己的断言）；
 * 本文件只验"JS 解包时**不会把这个 0 改写回 1**"。
 */
function toWire(s) {
  const other = KINDS.indexOf('Other');
  const rows = s.blocks.map(function (b) {
    const idx = KINDS.indexOf(b.kind);
    return [idx < 0 ? other : idx, b.start, b.end, s.eol === 'other' ? 0 : 1];
  });
  return {
    line_count: linesOf(s.text).length,
    block_kinds: KINDS.slice(),
    blocks: rows,
  };
}

/**
 * 一个样本上的**全部判据**。返回失败描述数组（空 ⇒ 通过）。
 *
 * ⚠️ 参数化 `mods`：变异自测要拿"改坏的 model/blocks"跑**同一套**判据，
 * 否则验的是另一套东西（`tests.md` 的"输出一模一样"那个坑）。
 */
function checkSample(s, mods) {
  const M = (mods && mods.M) || M0;
  const B = (mods && mods.B) || B0;
  const bad = [];
  const name = s.name;
  const lines = linesOf(s.text);
  const n = lines.length;

  // ① 归一化产物本身：非 `Other` 档**不许**有裸 CR / BOM（它们该被 envelope 吃掉）
  if (s.eol !== 'other') {
    if (String(s.text).indexOf('\r') >= 0) bad.push(name + '：eol=' + s.eol + ' 却含裸 CR');
    if (String(s.text).indexOf('\uFEFF') >= 0) bad.push(name + '：eol=' + s.eol + ' 却含 BOM');
  }

  // ② 行模型 ↔ 全文双向恒等（`'a\n' ⇒ ['a','']`：末尾那个空串是真实的一行）
  const s0 = M.createSession({ text: s.text, realPath: name });
  if (s0.lineCount() !== n) bad.push(name + '：lineCount ' + s0.lineCount() + ' ≠ ' + n);
  if (s0.fullText() !== s.text) bad.push(name + '：fullText 往返不一致');

  // ③ 块表合法：不越界、升序、不重叠
  let cursor = 0;
  for (let k = 0; k < s.blocks.length; k++) {
    const b = s.blocks[k];
    if (!Number.isInteger(b.start) || !Number.isInteger(b.end)) {
      bad.push(name + '：块 ' + k + ' 的行号不是整数');
    } else if (b.start < 1 || b.end < b.start || b.end > n) {
      bad.push(name + '：块 ' + k + ' 区间 [' + b.start + ',' + b.end + '] 越界（共 ' + n + ' 行）');
    } else if (b.start <= cursor) {
      bad.push(name + '：块 ' + k + ' 与上一块重叠');
    } else {
      cursor = b.end;
    }
  }

  // ④ ⭐ 核心：**任意**行区间「换成它自己」⇒ 全文逐字符不变。
  //    ⚠️ 穷举全部 (i,j) 而不是只跑块区间：off-by-one 最容易藏在
  //    「区间右端 = 最后一行」「区间为空」这类边界上，而那些恰恰不是块区间。
  //    ⚠️ 抛错**也算失败**（⛔ 别让它冒到顶层把整条测试变成一次崩溃）：
  //    `applyEdit` 越界就抛，而"越界"正是 off-by-one 最典型的形态。
  for (let i = 1; i <= n; i++) {
    for (let j = i; j <= n; j++) {
      try {
        const sess = M.createSession({ text: s.text });
        const out = sess.commit({ from: i - 1, to: j }, lines.slice(i - 1, j));
        if (out.fullText !== s.text) bad.push(name + '：自替换 [' + i + ',' + j + '] 改变了全文');
      } catch (e) {
        bad.push(name + '：自替换 [' + i + ',' + j + '] 抛错 ' + e.message);
      }
    }
  }

  // ⑤ 每个块「改一个字」：期望值独立算 ＋ 撤销必须回到原文
  for (let k = 0; k < s.blocks.length; k++) {
    const b = s.blocks[k];
    if (!(b.start >= 1 && b.end >= b.start && b.end <= n)) continue; // ③ 已记过
    const sess = M.createSession({ text: s.text });
    const next = lines.slice(b.start - 1, b.end);
    // ⚠️ 首个**码点**：`slice(0,1)` 会切开代理对（本批样本是 BMP，但判据不该靠这个前提）
    const cp = Array.from(next[0] || '');
    next[0] = cp.length ? 'A' + cp.slice(1).join('') : 'A';
    const expected = lines.slice(0, b.start - 1).concat(next, lines.slice(b.end)).join('\n');
    let out;
    try {
      out = sess.commit({ from: b.start - 1, to: b.end }, next);
    } catch (e) {
      bad.push(name + '：块 ' + k + ' 改字提交抛错 ' + e.message);
      continue;
    }
    if (out.fullText !== expected) bad.push(name + '：块 ' + k + ' 改字后全文不符');
    const prefix = lines.slice(0, b.start - 1).join('\n') + (b.start > 1 ? '\n' : '');
    if (out.fullText.slice(0, prefix.length) !== prefix) {
      bad.push(name + '：块 ' + k + ' 的前缀（区间之上的行）被动过');
    }
    const suffix = (b.end < n ? '\n' : '') + lines.slice(b.end).join('\n');
    if (out.fullText.slice(out.fullText.length - suffix.length) !== suffix) {
      bad.push(name + '：块 ' + k + ' 的后缀（区间之下的行）被动过');
    }
    let back;
    try {
      back = sess.undo();
    } catch (e) {
      bad.push(name + '：块 ' + k + ' 撤销抛错 ' + e.message);
      continue;
    }
    if (!back || back.fullText !== s.text) bad.push(name + '：块 ' + k + ' 撤销后没回到原文');
  }

  // ⑥ 线格式解包（`blocks.js::fromPayload`，⚠️ 真行号、真种类名）
  const parsed = B.fromPayload(toWire(s));
  if (parsed.issues.length) bad.push(name + '：fromPayload 报「' + parsed.issues.join('；') + '」');
  if (parsed.blocks.length !== s.blocks.length) {
    bad.push(name + '：解包后 ' + parsed.blocks.length + ' 块 ≠ Rust 的 ' + s.blocks.length + ' 块');
  }
  for (let k = 0; k < Math.min(parsed.blocks.length, s.blocks.length); k++) {
    const p = parsed.blocks[k];
    const r = s.blocks[k];
    if (p.from !== r.start - 1 || p.to !== r.end) bad.push(name + '：块 ' + k + ' 的 0-based 折算不对');
    if (p.kind !== r.kind) bad.push(name + '：块 ' + k + ' 的种类解包成 ' + p.kind + '（Rust 是 ' + r.kind + '）');
    if (KINDS.indexOf(r.kind) < 0) bad.push(name + '：种类名 ' + r.kind + ' 不在前端的十项表里');
    // ⭐ `Eol::Other` 的那一档：0 进来必须还是 `false`（⛔ 不许被前端"修正"成可编辑）
    if (p.editable !== (s.eol !== 'other')) bad.push(name + '：块 ' + k + ' 的 editable 被改写成 ' + p.editable);
    if (!B.locate(parsed.blocks, p.from)) bad.push(name + '：locate 找不到块 ' + k);
  }

  return bad;
}

/** 从**源码**重新编译一份产品模块（变异自测用；⛔ 改导出对象对闭包无效）。 */
function recompile(src) {
  const mod = { exports: {} };
  // ⚠️ 与产品 IIFE 的 `typeof window` 判据同形：传 undefined 等价于"没有 window"
  new Function('module', 'window', src)(mod, undefined);
  return mod.exports;
}

/**
 * 源码变异：`needle` **必须恰好出现 1 次**（⛔ 否则是"没改到"，与"判据不敏感"同形）。
 * @returns {{src:string, api:object}}
 */
function mutate(src, needle, replacement) {
  const parts = src.split(needle);
  assert.strictEqual(parts.length, 2, '变异目标必须恰好命中 1 次：' + JSON.stringify(needle.slice(0, 40)));
  const next = parts.join(replacement);
  assert.notStrictEqual(next, src, '变异必须真的改到源码');
  return { src: next, api: recompile(next) };
}

const MODEL_SRC = fs.readFileSync(MODEL_PATH, 'utf8');
const BLOCKS_SRC = fs.readFileSync(BLOCKS_PATH, 'utf8');

let DOC = null;
if (FIXTURE) DOC = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

if (!DOC) {
  test('⛔ 没有夹具（RMD_COMMIT_JSON 未设）⇒ 本闸门**没有运行**', function (t) {
    t.skip('用 `make probe-live-commit` 跑（它会先用 live-probe 生成样本）');
  });
} else {
  test('① 夹具来自 Rust：条数对得上，7 类信封与内容形态都覆盖到', function () {
    assert.strictEqual(DOC.count, DOC.samples.length, 'count 与实际条数不一致');
    assert.ok(DOC.samples.length >= 7, '样本少于 7 条：' + DOC.samples.length);

    const names = DOC.samples.map(function (s) { return s.name; });
    assert.strictEqual(new Set(names).size, names.length, '样本名有重复');

    const eols = new Set(DOC.samples.map(function (s) { return s.eol; }));
    ['lf', 'crlf', 'other'].forEach(function (e) {
      assert.ok(eols.has(e), '缺 ' + e + ' 档的样本');
    });

    const texts = DOC.samples.map(function (s) { return s.text; });
    assert.ok(texts.indexOf('') >= 0, '缺**空文件**样本');
    assert.ok(
      texts.some(function (t) { return t.length > 0 && t.charAt(t.length - 1) !== '\n'; }),
      '缺**没有尾换行**的样本（行模型的末尾空行只在这一档才暴露）'
    );

    // ⚠️ 种类覆盖：太少说明样本退化成同一形状，本闸门就只是在验一条路径
    const kinds = new Set();
    DOC.samples.forEach(function (s) {
      s.blocks.forEach(function (b) {
        assert.ok(KINDS.indexOf(b.kind) >= 0, '种类名不在十项表里：' + b.kind);
        kinds.add(b.kind);
      });
    });
    assert.ok(kinds.size >= 5, '内容形态只覆盖了 ' + kinds.size + ' 种：' + Array.from(kinds).join(','));
  });

  test('② 每个样本：提交逐字符无损（自替换 / 改字 / 撤销 / 解包）', function () {
    const bad = [];
    DOC.samples.forEach(function (s) {
      Array.prototype.push.apply(bad, checkSample(s));
    });
    assert.deepStrictEqual(bad, [], bad.join('\n'));
  });

  test('③ 变异自测：把产品源码弄坏，② 必须各自打红（⚠️ 打的是**源码**）', function () {
    const base = DOC.samples.filter(function (s) { return s.text.length > 0; });

    // 基线先在"什么都不改"上跑出 0 —— ⛔ 否则后面的"打红"证明不了任何事
    const baseline = [];
    DOC.samples.forEach(function (s) {
      Array.prototype.push.apply(baseline, checkSample(s));
    });
    assert.deepStrictEqual(baseline, [], '基线就不干净，变异自测无意义');

    const MUT = [];

    // M1 `splitLines` 丢空行（`'a\n'` 变成 1 行的那类错）
    const m1 = mutate(
      MODEL_SRC,
      ": text).split('\\n');",
      ": text).split('\\n').filter(function (x) { return x !== ''; });"
    );
    MUT.push(['model：splitLines 丢空行', { M: m1.api }]);

    // M2 `applyEdit` 右端 off-by-one（"块尾敲一个字，下一块首字没了"）
    const m2 = mutate(
      MODEL_SRC,
      'return cur.slice(0, from).concat(mid, cur.slice(to));',
      'return cur.slice(0, from).concat(mid, cur.slice(to + 1));'
    );
    MUT.push(['model：applyEdit 右端 off-by-one', { M: m2.api }]);

    // M3 `joinLines` 换行符改成 CRLF（归一化被绕过的形状）
    const m3 = mutate(MODEL_SRC, "(lines || []).join('\\n')", "(lines || []).join('\\r\\n')");
    MUT.push(['model：joinLines 输出 CRLF', { M: m3.api }]);

    // M4 `blocks.js` 把 `editable` 强行当 `true`（`Eol::Other` 的整篇闸被前端抹掉）
    const b1 = mutate(BLOCKS_SRC, 'const editable = row[3] === 1;', 'const editable = true;');
    MUT.push(['blocks：editable 被抹成 true', { B: b1.api }]);

    MUT.forEach(function (pair) {
      const label = pair[0];
      const mods = pair[1];
      let red = 0;
      base.forEach(function (s) {
        red += checkSample(s, mods).length;
      });
      assert.ok(red > 0, '变异「' + label + '」一条判据都没红 ⇒ 判据不敏感');
    });

    // 夹具侧两处：越界与"归一化没生效"
    const F = [
      ['夹具：块右端越界', function (s) { s.blocks[0].end = linesOf(s.text).length + 3; }],
      ['夹具：非 Other 档塞回裸 CR', function (s) {
        if (s.eol === 'other') s.eol = 'lf';
        s.text = String(s.text).replace('\n', '\r\n');
      }],
      ['夹具：非 Other 档塞回 BOM', function (s) { s.eol = 'lf'; s.text = '\uFEFF' + s.text; }],
    ];
    F.forEach(function (pair) {
      let red = 0;
      DOC.samples.forEach(function (s) {
        const c = JSON.parse(JSON.stringify(s));
        if (c.blocks.length === 0) return;
        pair[1](c);
        red += checkSample(c).length;
      });
      assert.ok(red > 0, '夹具变异「' + pair[0] + '」一条判据都没红');
    });
  });
}
