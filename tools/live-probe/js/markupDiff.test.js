'use strict';

// `design/0052` **U9**：**Lezer ↔ comrak 的方言差分表**（`make probe-live-markup` 的 JS 半）。
//
// # 它回答的是哪一个问题
//
// `design/0052` 把「该藏的标记」整个交给语法树（U3）之后，读态与编辑态本应是同一棵树的两种
// 呈现。可是**解析器有两个**：阅读态 HTML 是 Rust 侧 comrak 渲染的（`INV-SEC-01`），
// 编辑态的标记是前端 `@lezer/markdown` 算的。两个方言实现不保证一致 ⇒
// **某个标记会"永远不消失"或"永远消失"**，而且两边都不报错。
//
// 所以本文件**只比一件事**：同一份语料、同一行同一位置，**该不该藏**。
// ⛔ 不比树形（节点命名 / 嵌套深度本来就不一样，比了只有噪声）。
//
// # ⚠️ 差异**不判红**（U9 原文）
//
// 两个解析器的方言差异是**外部事实**，不是本仓的 bug。判红只会逼着人把差分表调成恒绿。
// 它落成两样东西（都由本文件的输出生成）：
//   · `docs/research/notes/` 的数据表（这份表就是产物本身）；
//   · 一条 `docs/kb/` 条目（外部依赖就这样，改不动）。
// ⇒ 本文件的断言**只做自检**：语料真被处理了、坐标换算没吃掉字符、差分器真能看见差异。
//
// # ⚠️ 两侧各归各的，⛔ 不互相抄
//
// | 侧 | 谁算的 | 在哪 |
// |---|---|---|
// | comrak | 产品那份解析 ＋ `sourcepos` | `live-probe --markup-json`（本文件的输入） |
// | Lezer | **产品那份** `markers()` | `src/live/decorations.js`（`require` 进来的原件） |
//
// ⭐ 关键：JS 侧**不重写**"该藏什么"的判定——`HIDDEN_MARK` 在那儿只有一份
// （`INV-SINGLE-01`）。本文件只负责**把两边摆到同一套坐标上**再逐位置比。
//
// ⚠️ 坐标：Rust 出的是**绝对 UTF-8 字节**（产品 `sourcepos_chars: false` 的口径），
//    JS 侧换算成 UTF-16 下标。换算表在字符边界上才有值 ⇒ **落在字符中间就说明
//    Rust 侧的区间算错了**，自检会当场红（2026-10-27 真抓到过一次：
//    多字节字符的 `end.column` 指向的是**最后一个字节**，按首字节算长度会多吃两个字节）。
//
// # 运行方式
//
// ```bash
// make probe-live-markup       # ✅ 只有这个入口（它会先跑 Rust 出夹具）
// ```
// ⚠️ 单独跑本文件时**必须**给 `RMD_MARKUP_JSON`；没有夹具就**只报 skip**
// ——⛔ 别把"看空"当成"通过"（`.claude/rules/tests.md` 的那个坑）。
// ⚠️ `RMD_MARKUP_TABLE` 指向表要写到哪（缺省 = 夹具旁边同名 `.table.md`）。
//
// # ⚠️ `RMD_MARKUP_PLAIN=1`：只比**顶层段落/标题**里的内容
//
// 默认比全部顶层块（⭐ 夹具语料就是靠这一档覆盖引用/列表/围栏的）。
// 但**真实文档**里必须开这一档：comrak 的**行内** `sourcepos` 在**表格行**里会漂
// （产品自己的 `rmd probe --file` 就报 `Code @ 98:363–98:386 换算失败`），
// 在**列表/引用的续行**里也不可靠（2026-10-27 实测：`design/0024` 第 504 行之后
// comrak 干脆不再产出行内标记）。⇒ 那是**提取器的边界**，⛔ 不是解析器方言，
// 混进来只会把方言差异淹掉。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const D = require('../../../src/live/decorations.js');
// ⚠️ `@codemirror/lang-markdown` 是 ESM，但 node ≥ 22.12 的 `require(esm)` 能直接取到命名导出。
//    ⇒ 拿到的是**产品同一个**解析器（`main.js` 用的就是 `markdownLanguage`）。
const { markdownLanguage } = require('@codemirror/lang-markdown');

const FIXTURE = process.env.RMD_MARKUP_JSON || '';
const TABLE_OUT = process.env.RMD_MARKUP_TABLE || (FIXTURE ? FIXTURE.replace(/\.json$/, '') + '.table.md' : '');
const PLAIN_ONLY = process.env.RMD_MARKUP_PLAIN === '1';

const SKIP = FIXTURE ? false : '没有 RMD_MARKUP_JSON —— 先跑 `make probe-live-markup`（⛔ 看空不算通过）';

/**
 * 字节偏移 → UTF-16 下标。
 *
 * ⚠️ **只在字符边界上有值**（其余是 `-1`）：写进去一个"向下取整"会让差分表
 *    把两个解析器的差异和提取器的 off-by-one 混成一锅。
 * @param {string} text
 * @returns {Int32Array}
 */
function byteToUtf16(text) {
  const map = new Int32Array(Buffer.byteLength(text, 'utf8') + 1).fill(-1);
  let b = 0;
  for (let i = 0; i < text.length; ) {
    map[b] = i;
    const cp = /** @type {number} */ (text.codePointAt(i));
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  map[b] = text.length;
  return map;
}

/**
 * 顶层块 → 产品真正交给编辑器的那些切片。
 *
 * ⚠️ 必须**逐字照抄产品的切片口径**（`live/index.js::sliceLines`：
 *    `splitLines(text).slice(start - 1, end).join('\n')`），否则两边比的不是同一段文本。
 * @param {string} text
 * @param {Array<{start:number,end:number,kind:string}>} blocks
 * @returns {Array<{kind:string,start:number,end:number,text:string,base:number}>}
 */
function blockSlices(text, blocks) {
  const lines = text.split('\n');
  const lineStart = [0];
  for (let i = 0; i < lines.length; i++) lineStart.push(lineStart[i] + lines[i].length + 1);
  return blocks
    .filter(function (b) {
      return b.start >= 1 && b.end >= b.start && b.end <= lines.length;
    })
    .map(function (b) {
      return {
        kind: b.kind,
        start: b.start,
        end: b.end,
        text: lines.slice(b.start - 1, b.end).join('\n'),
        base: lineStart[b.start - 1],
      };
    });
}

/**
 * 把区间集合摊成"每个字符藏不藏"的位图。
 * @param {number} size
 * @param {Array<{from:number,to:number}>} ranges
 * @param {number} [base]
 * @returns {Uint8Array}
 */
function bitmap(size, ranges, base) {
  const off = base || 0;
  const out = new Uint8Array(size);
  ranges.forEach(function (r) {
    for (let i = Math.max(0, r.from + off); i < Math.min(size, r.to + off); i++) out[i] = 1;
  });
  return out;
}

/**
 * 逐位置比两张位图，把**连续的差异**合成一段。
 * @param {string} text
 * @param {Uint8Array} l Lezer（产品 `markers()`）
 * @param {Uint8Array} c comrak（`sourcepos`）
 * @returns {Array<{line:number,column:number,text:string,lezer:boolean,comrak:boolean}>}
 */
function diffHidden(text, l, c) {
  const runs = [];
  let i = 0;
  while (i < text.length) {
    if (l[i] === c[i]) {
      i++;
      continue;
    }
    const from = i;
    while (i < text.length && l[i] !== c[i]) i++;
    // 行号/列号（1-based；列按 UTF-16 数，⚠️ 只用于**定位**，不参与比较）
    let line = 1;
    let col = 1;
    for (let k = 0; k < from; k++) {
      if (text.charCodeAt(k) === 10) {
        line++;
        col = 1;
      } else col++;
    }
    runs.push({
      line: line,
      column: col,
      text: text.slice(from, i),
      lezer: l[from] === 1,
      comrak: c[from] === 1,
    });
  }
  return runs;
}

/**
 * 一份文档的完整差分。
 * @param {{name:string,text:string,blocks:Array<{start:number,end:number,kind:string}>,marks:Array<{kind:string,from:number,to:number}>}} doc
 */
function compareDoc(doc) {
  const text = String(doc.text);
  const map = byteToUtf16(text);
  /**
   * **字节**偏移 → 1-based 行号。
   * ⚠️ 必须按字节走：拿字节当 UTF-16 下标数换行，中文文档会整篇错位
   *    （2026-10-27 实测：`catalog.md` 第 116 行的端点被算到了别的行上，
   *    于是"表格行的已知缺陷"这条豁免没生效，自检假红）。
   */
  const lineStartByte = [0];
  {
    let b = 0;
    for (let i = 0; i < text.length; ) {
      const cp = /** @type {number} */ (text.codePointAt(i));
      if (cp === 10) lineStartByte.push(b + 1);
      b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      i += cp > 0xffff ? 2 : 1;
    }
  }
  function lineAt(pos) {
    let lo = 0;
    let hi = lineStartByte.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStartByte[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  /** 这条行号是否落在某个 `Table` 顶层块里（comrak 在表格行里的列口径**会漂**）。 */
  const tableRanges = doc.blocks.filter(function (b) {
    return b.kind === 'Table';
  });
  function inTable(line) {
    return tableRanges.some(function (b) {
      return line >= b.start && line <= b.end;
    });
  }
  /**
   * `RMD_MARKUP_PLAIN=1` 时的白名单：只有**顶层段落/标题**里的行算数。
   * ⚠️ 按**行**判定（不是按块）：顶层 `List` 里也可能夹着一行段落，但它的行内标记
   *    和列表续行一样不可靠 ⇒ 宁可少比，也不要把提取器缺陷混进方言差异。
   */
  const plainRanges = doc.blocks.filter(function (b) {
    return b.kind === 'Paragraph' || b.kind === 'Heading';
  });
  function inPlain(line) {
    return plainRanges.some(function (b) {
      return line >= b.start && line <= b.end;
    });
  }
  // ⭐ 自检：comrak 标记的端点必须落在**字符边界**上，且换算单调不倒退。
  // ⚠️ 两个桶：`badTable` = 已知的 comrak 口径缺陷（见下），`badOther` = **必红**。
  //    📌 为什么表格行要单独放：`rmd probe --file docs/research/catalog.md` 自己的
  //    步骤 0 就报过 `Text @ 98:360–98:362 换算失败`——comrak 在**表格行**里给的列
  //    是相对"重建出来的那一行"算的，和原文的字节列会漂。⚠️ 那是**上游**的事，
  //    不是本仓的 bug ⇒ 只登记、不判红；但**表格之外**的同类现象一定是提取器写错了。
  const badTable = [];
  const badOther = [];
  let prev = -1;
  doc.marks.forEach(function (m) {
    [m.from, m.to].forEach(function (b) {
      if (b < 0 || b >= map.length || map[b] < 0) {
        const tag = m.kind + ':' + b;
        (inTable(lineAt(b)) ? badTable : badOther).push(tag);
      }
    });
  });
  // comrak 位图（⚠️ 端点非法的那几条先跳过——它们进了 `badTable`，在报告里单独计数）
  const cRanges = doc.marks
    .filter(function (m) {
      return map[m.from] >= 0 && map[m.to] >= 0;
    })
    .map(function (m) {
      return { from: map[m.from], to: map[m.to] };
    });
  cRanges.sort(function (a, b) {
    return a.from - b.from || a.to - b.to;
  });
  cRanges.forEach(function (r) {
    if (r.from < prev) badOther.push('overlap@' + r.from);
    prev = r.to;
  });
  const cBit = bitmap(text.length, cRanges);

  // Lezer 位图：**一块一块**解析（这就是产品的真行为），行号/偏移都相对切片。
  const slices = blockSlices(text, doc.blocks);
  const lBit = new Uint8Array(text.length);
  let lRanges = 0;
  slices.forEach(function (s) {
    const tree = markdownLanguage.parser.parse(s.text);
    const m = D.markers(s.text, { tree: tree });
    lRanges += m.ranges.length;
    m.ranges.forEach(function (r) {
      for (let i = Math.max(0, s.base + r.from); i < Math.min(text.length, s.base + r.to); i++) lBit[i] = 1;
    });
  });

  const allRuns = diffHidden(text, lBit, cBit);
  // ⚠️ `RMD_MARKUP_PLAIN=1`：只把**顶层段落/标题行**上的差异算进结论，
  //    其余（引用/列表/表格/围栏里）单独计数。⚠️ 按 run 的**起始行**归属；
  //    跨行的 run 实际不存在（差异都是行内的一段标记），此处只作保险。
  const runs = PLAIN_ONLY
    ? allRuns.filter(function (r) {
        return inPlain(r.line);
      })
    : allRuns;
  const outsideRuns = PLAIN_ONLY
    ? allRuns.filter(function (r) {
        return !inPlain(r.line);
      })
    : [];
  return {
    name: doc.name,
    text: text,
    slices: slices,
    comrak: cRanges.length,
    lezer: lRanges,
    // ⚠️ 顺序很重要：`lezer` 是"到底藏不藏"的第一问
    runs: runs,
    outside: outsideRuns,
    onlyComrak: runs.filter(function (r) {
      return r.comrak && !r.lezer;
    }).length,
    onlyLezer: runs.filter(function (r) {
      return r.lezer && !r.comrak;
    }).length,
    outsideOnlyComrak: outsideRuns.filter(function (r) {
      return r.comrak && !r.lezer;
    }).length,
    outsideOnlyLezer: outsideRuns.filter(function (r) {
      return r.lezer && !r.comrak;
    }).length,
    badTable: badTable,
    badOther: badOther,
  };
}

/** Markdown 表里不能出现裸 `|`。 */
function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, '⏎');
}

/** 整份报告（落盘的那一份）。 */
function report(reps) {
  const out = [];
  out.push('# Lezer ↔ comrak 的标记差分表（`design/0052` U9）');
  out.push('');
  out.push('> ⚠️ 本文件由 `make probe-live-markup` **生成**，⛔ 不手改；差异**不是 bug**，是方言事实。');
  out.push('>');
  out.push(
    PLAIN_ONLY
      ? '> 口径：**只比顶层段落/标题行**（`RMD_MARKUP_PLAIN=1`）；引用/列表/表格/围栏里的差异只计数（最后一栏），⛔ 不计入结论。'
      : '> 口径：**全部顶层块**（未开 `RMD_MARKUP_PLAIN`）。'
  );
  out.push('');
  out.push('| 文档 | 顶层块 | comrak 标记 | Lezer 标记 | 仅 comrak | 仅 Lezer | comrak 端点不可换算（表格行） | 容器内差异（不计入） |');
  out.push('|---|---|---|---|---|---|---|---|');
  reps.forEach(function (r) {
    out.push(
      '| ' + [r.name, r.slices.length, r.comrak, r.lezer, r.onlyComrak, r.onlyLezer, r.badTable.length, r.outside.length].join(' | ') + ' |'
    );
  });
  out.push('');
  reps.forEach(function (r) {
    if (!r.runs.length) return;
    out.push('## ' + r.name);
    out.push('');
    out.push('| 行 | 列 | 文本 | Lezer 藏 | comrak 藏 |');
    out.push('|---|---|---|---|---|');
    r.runs.forEach(function (x) {
      out.push(
        '| ' + [x.line, x.column, '`' + cell(x.text) + '`', x.lezer ? '✅' : '⛔', x.comrak ? '✅' : '⛔'].join(' | ') + ' |'
      );
    });
    out.push('');
  });
  return out.join('\n') + '\n';
}

function load() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

test('⭐ 夹具存在且语料真被处理（⛔ 空表与"全一致"长得一样）', { skip: SKIP }, function () {
  const d = load();
  assert.ok(d.count >= 5, '语料至少 5 份（实际 ' + d.count + '）');
  assert.strictEqual(d.docs.length, d.count, '`count` 必须等于 `docs` 长度');
  const reps = d.docs.map(compareDoc);
  const comrak = reps.reduce(function (n, r) { return n + r.comrak; }, 0);
  const lezer = reps.reduce(function (n, r) { return n + r.lezer; }, 0);
  assert.ok(comrak > 20, 'comrak 侧至少要藏出 20 个区间（实际 ' + comrak + '）');
  assert.ok(lezer > 20, 'Lezer 侧至少要藏出 20 个区间（实际 ' + lezer + '）');
  reps.forEach(function (r) {
    assert.ok(r.slices.length > 0, r.name + '：一个顶层块都没有');
  });
  // ⭐ 自检：坐标换算没有吃掉字符（端点必须落在字符边界、区间不许重叠倒退）
  //    ⚠️ 只允许**表格行**那一类例外（comrak 的上游口径，见 `compareDoc` 的注释）
  reps.forEach(function (r) {
    assert.deepStrictEqual(r.badOther, [], r.name + '：comrak 侧区间端点不在字符边界/有重叠（表格行之外）');
  });
  console.log(
    '语料 ' + reps.length + ' 份：comrak ' + comrak + ' 个区间、Lezer ' + lezer + ' 个，' +
      '差异段 ' + reps.reduce(function (n, r) { return n + r.runs.length; }, 0) + ' 处，' +
      'comrak 表格行端点不可换算 ' + reps.reduce(function (n, r) { return n + r.badTable.length; }, 0) + ' 个'
  );
});

test('⭐ 差分器自检：把一侧清空必须看得见差异（⛔ 恒定绿的分差器等于没有）', { skip: SKIP }, function () {
  const d = load();
  const reps = d.docs.map(compareDoc);
  reps.forEach(function (r) {
    assert.ok(r.comrak > 0 || r.lezer > 0, r.name + '：两侧一个区间都没藏 ⇒ 这份语料没在承重');
  });

  // 真差分器：拿产品 `markers()` 的正常结果 vs **空位图**，必须报出差异
  const first = d.docs[0];
  const text = String(first.text);
  const slices = blockSlices(text, first.blocks);
  const lBit = new Uint8Array(text.length);
  slices.forEach(function (s) {
    const m = D.markers(s.text, { tree: markdownLanguage.parser.parse(s.text) });
    m.ranges.forEach(function (rr) {
      for (let i = Math.max(0, s.base + rr.from); i < Math.min(text.length, s.base + rr.to); i++) lBit[i] = 1;
    });
  });
  const neither = diffHidden(text, lBit, new Uint8Array(text.length));
  assert.ok(neither.length > 0, 'Lezer 藏了东西而 comrak 全空 ⇒ 差异段必须 > 0');
  // 反向：两边同一份位图 ⇒ 必须 0 处
  assert.deepStrictEqual(diffHidden(text, lBit, lBit), [], '同一张位图不许报出差异');
});

test('⭐ 差分表落盘（差异**不判红**，只要求它可见）', { skip: SKIP }, function () {
  const d = load();
  const reps = d.docs.map(compareDoc);
  const md = report(reps);
  assert.ok(TABLE_OUT, '没有 RMD_MARKUP_TABLE 且夹具路径推不出表路径');
  fs.writeFileSync(TABLE_OUT, md);
  const onlyComrak = reps.reduce(function (n, r) { return n + r.onlyComrak; }, 0);
  const onlyLezer = reps.reduce(function (n, r) { return n + r.onlyLezer; }, 0);
  const outside = reps.reduce(function (n, r) { return n + r.outside.length; }, 0);
  console.log(
    '差分表：' + TABLE_OUT + '（仅 comrak ' + onlyComrak + ' 段 / 仅 Lezer ' + onlyLezer + ' 段' +
      (PLAIN_ONLY ? '；容器内另有 ' + outside + ' 段不计入' : '') + '）'
  );
  assert.ok(md.indexOf('| 文档 |') > 0, '表头没写出来');
});
