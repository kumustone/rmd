// `bugs/0305` 的**序列不变式**：单步全绿、多敲几下才坏的缺陷不在单步测试里。
//
// 为什么要有这一份：
//   0305 的症状是「列表里连着敲回车，敲几次后行距突然变大，而且**删也删不回去**」。
//   它的共同形态是 **路径依赖**：最终文档（甚至逐字节相同的文档）由不同的按键序列
//   得到时，装饰/行高判据可能不是同一个函数值；而任何**单步**用例都只覆盖其中一条路径。
//   本文件把「动作序列 × 不变式」当 oracle：不复制产品的松紧算法，装饰判据**只调用**
//   `src/live/decorations.js::markers()`，再逐值比较它给出的隐藏区间 / 行级类 / 段距行。
//
// ⚠️ 纯逻辑：不碰 DOM、不建编辑视图、不合成按键。真 IME、真几何仍要各自那一层，
//    ⛔ 不拿这份 Node 测试冒充（`.claude/rules/tests.md`）。
//
// ⚠️ 操作集**只映射到真实命令**：
//    `enter`             → `input.js::lineBreakAction`（main.js 的 Enter 分支）
//    `backspace`         → `selection.js::deleteRange(forward:false)`
//    `deleteForward`     → `selection.js::deleteRange(forward:true)`
//    `lineStartBackspace`→ Home（列表行吸到正文起点）＋ ⌫，即 0305 里用户自然的撤回动作
//    `lastLineDelete`    → 末行行首 ＋ ⌦
//    `tab` / `shiftTab`  → **文档层无操作**。这两个键的真实语义是「提交并退出编辑态」
//                          （`main.js::onKeyDown`，`leaveLive`），当前 `live/**` **没有**
//                          缩进/反缩进命令。⛔ 不臆造一个缩进算法；建模成 no-op 是为了让
//                          序列空间与实际按键集合一致（它们不改文档）。
//
// ⭐ 固定种子：0x0305C0DE（`0305` ＋ `CODE`）。⛔ 不要改用 `Math.random`——失败必须可复现。
//
// ⚠️ 关于「空列表项上再回车」这条幂等样例：当前产品**故意**把它定义成「删标记退列表」
//    （`input.js::lineBreakAction` 分支 ③），所以第一次按就**有效果**，不是「本来就无效果」
//    的操作；`op(op(x)) == op(x)` 在这一档不成立、也不应该成立。本文件按真实契约判它
//    （见「不变式 2」里的偏离说明与 `test('空项回车：不是「无效果」操作…')`），
//    幂等扫描仍覆盖所有**真正**无效果的按键。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../../src/live/decorations.js');
const S = require('../../src/live/selection.js');
const I = require('../../src/live/input.js');
// ⚠️ `@codemirror/lang-markdown` / `state` / `commands` 是 ESM，node ≥ 22.12 的
//    `require(esm)` 能直接取到命名导出 ⇒ 拿到的是**产品同一个**解析器与撤销实现。
const { markdownLanguage } = require('@codemirror/lang-markdown');
const { EditorState } = require('@codemirror/state');
const { history, undo } = require('@codemirror/commands');

const DEFAULT_MODS = { D: D, S: S, I: I };
const SEED = 0x0305C0DE;

// ── 最小假文档适配器（口径与 `tests/js/live-selection.test.js` 一致）─────────

/**
 * CM6 `Text` 的最小替身：`lineAt(pos).to` 是行尾**之前**，`length` 是 UTF-16 码元数。
 * @param {string} text
 * @returns {object}
 */
function doc(text) {
  const src = String(text);
  const lines = src.split('\n');
  const starts = [];
  let p = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(p);
    p += lines[i].length + 1;
  }
  return {
    length: src.length,
    lines: lines.length,
    lineAt: function (pos) {
      const at = Math.max(0, Math.min(pos, src.length));
      let i = lines.length - 1;
      for (let k = 0; k < lines.length; k++) {
        if (at <= starts[k] + lines[k].length) { i = k; break; }
      }
      return { number: i + 1, from: starts[i], to: starts[i] + lines[i].length, text: lines[i] };
    },
  };
}

/** 产品同一个解析器。 */
function parse(text) {
  return markdownLanguage.parser.parse(String(text));
}

/** 装饰层判据：⛔ 只调用真实 `markers()`，不自己写松紧/行高算法。 */
function planOf(mods, text, listHost) {
  return mods.D.markers(text, { tree: parse(text), listHost: listHost });
}

// ── 装饰 / 行高判据：真实 plan 的**逐值快照** ────────────────────────────────

/**
 * 把 plan 里的行级判据投影成「偏移 → 类名集合」。
 *
 * ⚠️ 这是**投影**，不是第二套算法：类名取自 `decorations.js::createField` 的同一批
 *    `Decoration.line` 调用（`cm-rmd-h*` / `cm-rmd-body` / `cm-rmd-li` / `cm-rmd-collapsed` …）。
 * ⚠️ `design/0066`（2026-11-11）起**没有** `listGapLines` / `listSepLines` 那两路投影：
 *    列表内的段距不存在（「松散不存在，空行照排」），再投影它们只会把空值当判据。
 * @param {object} plan
 * @returns {object}
 */
function classesOf(plan) {
  const byOffset = {};
  function add(off, cls) {
    if (!byOffset[off]) byOffset[off] = [];
    byOffset[off].push(cls);
  }
  (plan.headings || []).forEach(function (h) { add(h.from, 'cm-rmd-h' + h.level); });
  (plan.bodies || []).forEach(function (b) { add(b.from, 'cm-rmd-body'); });
  (plan.fenceLines || []).forEach(function (f) { add(f.from, 'cm-rmd-fence'); });
  (plan.collapsedLines || []).forEach(function (f) { add(f.from, 'cm-rmd-collapsed'); });
  (plan.quoteGapLines || []).forEach(function (g) { add(g.from, 'cm-rmd-quote-gap'); });
  (plan.nestedCodeLines || []).forEach(function (c) {
    add(c.from, 'cm-rmd-code-line');
    if (c.first) add(c.from, 'cm-rmd-code-first');
    if (c.last) add(c.from, 'cm-rmd-code-last');
  });
  (plan.nestedHeadingSpaces || []).forEach(function (s) {
    add(s.from, s.where === 'before' ? 'cm-rmd-heading-space-before' : 'cm-rmd-heading-space-after');
  });
  (plan.listLines || []).forEach(function (li) { add(li.from, 'cm-rmd-li'); });
  Object.keys(byOffset).forEach(function (k) { byOffset[k].sort(); });
  return byOffset;
}

/**
 * 最终文档的**装饰/行高判据**。逐值比较这一份，就等价于比较
 * 「进入编辑态后屏幕上每个标记藏不藏、每行是什么品种、每段补不补段距」。
 * @param {{D:object,S:object,I:object}} mods
 * @param {string} text
 * @param {boolean} listHost
 * @returns {object}
 */
function fingerprint(mods, text, listHost) {
  const p = planOf(mods, text, listHost);
  return {
    fenced: p.fenced,
    ranges: p.ranges,
    headings: p.headings,
    bodies: p.bodies,
    inline: p.inline,
    fenceLines: p.fenceLines,
    collapsedLines: p.collapsedLines,
    listLines: p.listLines,
    tasks: p.tasks,
    quoteGapLines: p.quoteGapLines,
    nestedCodeLines: p.nestedCodeLines,
    // ⚠️ `design/0066` 起没有 `listGapLines` / `listSepLines`（模型 A：列表内没有段距）。
    nestedHeadingSpaces: p.nestedHeadingSpaces,
    lineClasses: classesOf(p),
  };
}

// ── 动作序列的执行器 ───────────────────────────────────────────────────────

/**
 * 把一段文档变更落到内存态上。`head` 与 `main.js::onTransaction` 一致：
 * 落在插入文本之后（删除时落在 `from`）。
 * @param {{text:string, head:number}} st
 * @param {number} from
 * @param {number} to
 * @param {string} data
 * @returns {{text:string, head:number}}
 */
function replace(st, from, to, data) {
  return { text: st.text.slice(0, from) + data + st.text.slice(to), head: from + data.length };
}

/**
 * 执行**一个真实按键**。
 *
 * @param {{D:object,S:object,I:object}} mods 允许替换成故意改错的替身（变异自检用）
 * @param {string} name 操作名（见文件头的映射）
 * @param {{text:string, head:number}} st 动作前的状态（折叠光标）
 * @param {boolean} listHost 宿主是不是 `<ul>` / `<ol>`（`bugs/0305`）
 * @returns {{state:{text:string, head:number}, edit:{preText:string,preHead:number,
 *   from:number,to:number,insert:string,postText:string,postHead:number}|null}}
 */
function applyOp(mods, name, st, listHost) {
  const Sel = mods.S;
  const In = mods.I;
  const plan = planOf(mods, st.text, listHost);
  const d = doc(st.text);

  function del(fromHead, forward, byLine) {
    const hidden = Sel.protectedRanges({ state: { doc: d } },
      { plan: function () { return plan; } });
    const r = Sel.deleteRange(d, { anchor: fromHead, head: fromHead },
      { forward: forward, byLine: byLine, hidden: hidden });
    const pre = { text: st.text, head: fromHead };
    if (!(r.to > r.from)) return { state: pre, edit: null };
    const next = replace(pre, r.from, r.to, '');
    return {
      state: next,
      edit: {
        preText: pre.text, preHead: pre.head, from: r.from, to: r.to,
        insert: '', postText: next.text, postHead: next.head,
      },
    };
  }

  if (name === 'enter') {
    // ⚠️ 与 `main.js` 的 Enter 分支同序：先 `lineStartInsertPoint` 收插入点，
    //    再 `lineBreakAction` 决定续标记 / 删空项标记 / 裸换行。
    let from = st.head;
    const p = Sel.lineStartInsertPoint(plan.ranges, d, from);
    if (p >= 0) from = p;
    const act = In.lineBreakAction(st.text, plan, from, from);
    const data = act.type === 'delete' ? '' : act.data;
    const next = replace(st, act.from, act.to, data);
    return {
      state: next,
      edit: {
        // ⚠️ `lineStartInsertPoint` 的收敛**不是**一条事务（main.js 只在局部改 from/to）
        //    ⇒ 撤销要回到**原始光标**，不是收敛后的位置。
        preText: st.text, preHead: st.head, from: act.from, to: act.to,
        insert: data, postText: next.text, postHead: next.head,
      },
    };
  }
  if (name === 'backspace') return del(st.head, false, false);
  if (name === 'deleteForward') return del(st.head, true, false);
  if (name === 'lineStartBackspace') {
    // Home：列表行吸到**正文起点**（`snapCaret(dir=0)` 的判据是 `listContentStart`）。
    const line = d.lineAt(st.head);
    const c = Sel.listContentStart(plan, line.from);
    return del(c >= 0 ? c : line.from, false, false);
  }
  if (name === 'lastLineDelete') {
    const line = d.lineAt(d.length);
    const c = Sel.listContentStart(plan, line.from);
    return del(c >= 0 ? c : line.from, true, false);
  }
  if (name === 'tab' || name === 'shiftTab') {
    // 真实命令是 `leaveLive`（提交并退出编辑态）⇒ 文档层 no-op。
    return { state: st, edit: null };
  }
  throw new Error('未知操作 ' + name);
}

const OPS = ['enter', 'backspace', 'deleteForward', 'lineStartBackspace', 'lastLineDelete', 'tab', 'shiftTab'];

// ── 初始文档与序列生成 ─────────────────────────────────────────────────────

const INITIAL = [
  { name: '紧无序列表', text: '- 甲\n- 乙\n- 丙\n', listHost: true },
  { name: '松无序列表', text: '- 甲\n\n- 乙\n\n- 丙\n', listHost: true },
  { name: '嵌套有序列表', text: '1. 甲\n   1. 乙\n   2. 丙\n2. 丁\n', listHost: true },
  // 0305 的宿主形态：列表是在**段落 / 标题**的编辑框里现敲出来的（宿主不是 <ul>/<ol>）。
  { name: '段落宿主里的列表', text: '- 甲\n- 乙\n- 丙\n', listHost: false },
];

/** 所有长度 ≤ 3 的序列（7 + 49 + 343 = 399）。 */
function sequencesUpTo3() {
  const out = [];
  function rec(prefix) {
    if (prefix.length) out.push(prefix.slice());
    if (prefix.length === 3) return;
    for (let i = 0; i < OPS.length; i++) {
      prefix.push(OPS[i]);
      rec(prefix);
      prefix.pop();
    }
  }
  rec([]);
  return out;
}

/**
 * 固定种子的伪随机序列（线性同余，⛔ 不是 `Math.random`）。
 * @param {number} seed
 * @param {number} n
 * @returns {Array<{seq:string[], docIndex:number, headIndex:number}>}
 */
function randomSequences(seed, n) {
  let s = seed >>> 0;
  function rnd(k) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % k;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = 1 + rnd(8); // 1..8
    const seq = [];
    for (let j = 0; j < len; j++) seq.push(OPS[rnd(OPS.length)]);
    out.push({ seq: seq, docIndex: rnd(INITIAL.length), headIndex: rnd(4) });
  }
  return out;
}

const ALL_SEQS = sequencesUpTo3();
const RANDOMS = randomSequences(SEED, 200);

/**
 * 初始光标候选：文首、文末、首 / 末列表项的**正文起点**。
 * ⚠️ 0305 的撤回动作恰好是从「下一项正文起点」按 ⌫ ⇒ 这一格必须在起点集合里。
 * @param {{D:object,S:object,I:object}} mods
 * @param {object} init
 * @returns {number[]}
 */
function cursorPositions(mods, init) {
  const p = planOf(mods, init.text, init.listHost);
  const d = doc(init.text);
  const out = [0, d.length];
  if (p.listLines && p.listLines.length) {
    out.push(p.listLines[0].contentFrom);
    out.push(p.listLines[p.listLines.length - 1].contentFrom);
  }
  const seen = {};
  return out.filter(function (x) {
    const c = Math.max(0, Math.min(d.length, x));
    if (seen[c]) return false;
    seen[c] = true;
    return true;
  });
}

/**
 * 跑一条序列。
 * @param {{D:object,S:object,I:object}} mods
 * @param {object} init
 * @param {number} head
 * @param {string[]} seq
 * @returns {{state:{text:string,head:number}, trace:Array<object>}}
 */
function runSequence(mods, init, head, seq) {
  let st = { text: init.text, head: head };
  const trace = [];
  for (let i = 0; i < seq.length; i++) {
    const r = applyOp(mods, seq[i], st, init.listHost);
    st = r.state;
    trace.push({ op: seq[i], step: i + 1, edit: r.edit, text: st.text, head: st.head });
  }
  return { state: st, trace: trace };
}

/**
 * 穷举序列 ＋ 200 条随机序列的全部终态（**每条路径各自算一次装饰判据**）。
 * @param {{D:object,S:object,I:object}} mods
 * @returns {Array<object>}
 */
function collectRecords(mods) {
  const records = [];
  INITIAL.forEach(function (init) {
    const positions = cursorPositions(mods, init);
    positions.forEach(function (head) {
      ALL_SEQS.forEach(function (seq) {
        const r = runSequence(mods, init, head, seq);
        records.push({
          initName: init.name, initText: init.text, listHost: init.listHost,
          head: head, seq: seq, text: r.state.text, headAfter: r.state.head,
          fp: fingerprint(mods, r.state.text, init.listHost), trace: r.trace,
        });
      });
    });
  });
  RANDOMS.forEach(function (item) {
    const init = INITIAL[item.docIndex];
    const positions = cursorPositions(DEFAULT_MODS, init);
    const head = positions[item.headIndex % positions.length];
    const r = runSequence(mods, init, head, item.seq);
    records.push({
      initName: init.name, initText: init.text, listHost: init.listHost,
      head: head, seq: item.seq, text: r.state.text, headAfter: r.state.head,
      fp: fingerprint(mods, r.state.text, init.listHost), trace: r.trace,
    });
  });
  return records;
}

let RECORDS = null;
function records() {
  if (!RECORDS) RECORDS = collectRecords(DEFAULT_MODS);
  return RECORDS;
}

// ── 失败信息：可直接复现 ───────────────────────────────────────────────────

function fmtSeq(seq) {
  return '[' + seq.join(' → ') + ']';
}

function repro(rec, step) {
  return '初始文档：' + JSON.stringify(rec.initText)
    + '\n  初始光标：' + rec.head + '（listHost=' + rec.listHost + '）'
    + '\n  操作序列：' + fmtSeq(rec.seq)
    + '\n  第 ' + step + ' 步';
}

// ── 不变式判据（可单独喂给"故意改错的替身"，见变异自检） ────────────────────

/**
 * 不变式 1 的判据：同一初始文档、不同序列 ⇒ 逐字节相同的终态文本必须给出逐值相同的装饰。
 * @param {Array<object>} list
 * @returns {{ok:boolean, message?:string, compared:number, groups:number}}
 */
function checkPathIndependence(list) {
  const groups = new Map();
  list.forEach(function (rec) {
    const key = rec.initName + '|' + (rec.listHost === false ? '0' : '1') + '|' + rec.text;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  });
  let compared = 0;
  let collisions = 0;
  for (const pair of groups) {
    const g = pair[1];
    if (g.length < 2) continue;
    collisions++;
    const base = g[0];
    for (let i = 1; i < g.length; i++) {
      compared++;
      try {
        assert.deepStrictEqual(g[i].fp, base.fp);
      } catch (e) {
        return {
          ok: false,
          compared: compared,
          groups: collisions,
          message: '路径无关性被破坏：同一起点、终态文本逐字节相同，装饰判据却不同。\n'
            + repro(base, base.seq.length) + '（路径 A）'
            + '\n  路径 A：' + fmtSeq(base.seq) + '  光标=' + base.head
            + '\n  路径 B：' + fmtSeq(g[i].seq) + '  光标=' + g[i].head
            + '\n  最终文本：' + JSON.stringify(base.text)
            + '\n  预期（A 的装饰）：' + JSON.stringify(base.fp)
            + '\n  实际（B 的装饰）：' + JSON.stringify(g[i].fp),
        };
      }
    }
  }
  return { ok: true, compared: compared, groups: collisions };
}

/**
 * 不变式 2 的判据：一个**无效果**的动作连按两次必须等于按一次。
 * @param {function(object):object} apply
 * @param {{text:string, head:number}} state
 * @param {string} where
 * @returns {{ok:boolean, message?:string}}
 */
function checkNoOpTwice(apply, state, where) {
  const once = apply(state);
  const twice = apply(once);
  if (once.text !== twice.text || once.head !== twice.head) {
    return {
      ok: false,
      message: '幂等被破坏：' + where + '\n'
        + '  起点：' + JSON.stringify(state) + '\n'
        + '  按一次：' + JSON.stringify(once) + '\n'
        + '  再按一次：' + JSON.stringify(twice) + '\n'
        + '  预期（再按一次 == 按一次）：' + JSON.stringify(once),
    };
  }
  return { ok: true };
}

/**
 * 不变式 3 的判据：只重算装饰、不改文档 ⇒ `f(f(x)) == f(x)`。
 * @param {function(object):object} recompute
 * @param {Array<{text:string, listHost:boolean}>} cases
 * @returns {{ok:boolean, message?:string}}
 */
function checkFixedPoint(recompute, cases) {
  for (let i = 0; i < cases.length; i++) {
    const first = recompute(cases[i]);
    const second = recompute(cases[i]);
    try {
      assert.deepStrictEqual(second, first);
    } catch (e) {
      return {
        ok: false,
        message: '不动点被破坏：' + JSON.stringify(cases[i])
          + '\n  第一次重算：' + JSON.stringify(first)
          + '\n  第二次重算：' + JSON.stringify(second),
      };
    }
  }
  return { ok: true };
}

/**
 * 不变式 4a 的判据：插入 k 个字符 ＋ 退格 k 次必须回到逐字节原文档。
 * @param {function(object,string):object|null} insert
 * @param {function(object,boolean):object} back
 * @param {Array<object>} cases
 * @returns {{ok:boolean, message?:string}}
 */
function checkInsertBackspace(insert, back, cases) {
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const start = { text: c.init.text, head: c.head };
    let st = insert(start, c.data);
    if (!st) {
      return { ok: false, message: '可逆性判据：插入没有落地。用例：' + JSON.stringify(c) };
    }
    for (let k = 0; k < c.k; k++) st = back(st, c.init.listHost);
    if (st.text !== start.text || st.head !== start.head) {
      return {
        ok: false,
        message: '可逆性被破坏：插入 ' + JSON.stringify(c.data) + '（' + c.k + ' 个字符）＋ 退格 '
          + c.k + ' 次没有回到原点。\n'
          + '  初始文档：' + JSON.stringify(c.init.text) + '\n'
          + '  光标：' + c.head + '（listHost=' + c.init.listHost + '）\n'
          + '  预期：' + JSON.stringify(start) + '\n'
          + '  实际：' + JSON.stringify(st),
      };
    }
  }
  return { ok: true };
}

// ── 不变式 1：路径无关性 ───────────────────────────────────────────────────

test('不变式 1：路径无关性——终态文本逐字节相同 ⇒ 装饰/行高判据必须逐值相同（0305）', function () {
  assert.strictEqual(ALL_SEQS.length, 399, '穷举序列数应为 7 + 49 + 343 = 399');
  assert.strictEqual(RANDOMS.length, 200, '固定种子的随机序列应为 200 条');
  RANDOMS.forEach(function (r) {
    assert.ok(r.seq.length >= 1 && r.seq.length <= 8, '随机序列长度必须在 1..8：' + fmtSeq(r.seq));
  });

  const res = checkPathIndependence(records());
  assert.ok(res.groups >= 100,
    '判据覆盖不足：只有 ' + res.groups + ' 组「同一份终态文本、多条路径」'
    + '（需要 ≥ 100 组，否则这条不变式近似空跑）');
  assert.ok(res.ok, res.message);
});

test('不变式 1 的 0305 最小复现：松列表里从下一项正文起点按 ⌫，必须回到紧列表', function () {
  // 用户在 0305 里的动作：回车（得空项）→ 回车（得空行）→ 在下一项正文起点按 ⌫。
  const text = '- 甲\n- 乙\n\n- 丙\n';
  const plan = planOf(DEFAULT_MODS, text, true);
  assert.deepStrictEqual(plan.listLines.filter(function (l) { return l.kind === 'plain'; })
    .map(function (l) { return l.line; }), [2],
  '负对照：这份初始文档里那条空行是列表的续行（`design/0066` 起它只是普通一行高）');
  assert.deepStrictEqual(plan.collapsedLines, [],
    '负对照：模型 A 下空行不塌（塌了就是旧口径回来了）');
  const last = plan.listLines[plan.listLines.length - 1];
  const r = applyOp(DEFAULT_MODS, 'backspace', { text: text, head: last.contentFrom }, true);
  assert.strictEqual(r.state.text, '- 甲\n- 乙\n- 丙\n',
    '从下一项正文起点按 ⌫ 必须删掉那条空行，⛔ 不是删掉 `- ` 把列表标记吃掉');
  assert.deepStrictEqual(fingerprint(DEFAULT_MODS, r.state.text, true).listLines
    .map(function (l) { return l.kind; }), ['bullet', 'bullet', 'bullet'],
  '恢复后列表必须是紧的（空行已被 ⌫ 删掉）');
});

// ── 不变式 2：幂等 ─────────────────────────────────────────────────────────

test('不变式 2：幂等——无效果的按键连按两次 == 按一次（行首退格 / 文档末尾删除）', function () {
  // ① 行首再退格：文首行首按 ⌫ 没有东西可删。
  //    ⚠️ 用**裸 ⌫**，不是 `lineStartBackspace`：后者先按 Home 吸到列表正文起点，
  //    在第一条列表行上会删掉标记（那是有效果的，正是不变式 1 里 0305 的同一形态）。
  const start = { text: '- 甲\n- 乙\n', head: 0 };
  const back = function (st) { return applyOp(DEFAULT_MODS, 'backspace', st, true).state; };
  assert.strictEqual(applyOp(DEFAULT_MODS, 'backspace', start, true).edit, null,
    '负对照：文首的 ⌫ 必须是无效果操作');
  const firstBack = checkNoOpTwice(back, start, '行首再退格');
  assert.ok(firstBack.ok, firstBack.message);

  // ② 文档末尾再按删除：文档末按 ⌦ 没有下一个字符可删。
  const text = '- 甲\n- 乙\n';
  const end = { text: text, head: text.length };
  const fwd = function (st) { return applyOp(DEFAULT_MODS, 'deleteForward', st, true).state; };
  assert.strictEqual(applyOp(DEFAULT_MODS, 'deleteForward', end, true).edit, null,
    '负对照：文末的 ⌦ 必须是无效果操作');
  const firstFwd = checkNoOpTwice(fwd, end, '文档末尾再按删除');
  assert.ok(firstFwd.ok, firstFwd.message);

  // ③ 全序列扫描：任何一步只要**真的没有效果**（文档与光标都不动），第二步必须也不动。
  let steps = 0;
  let noops = 0;
  records().forEach(function (rec) {
    let prev = { text: rec.initText, head: rec.head };
    rec.trace.forEach(function (tr) {
      steps++;
      if (!tr.edit && tr.text === prev.text && tr.head === prev.head) {
        noops++;
        const again = applyOp(DEFAULT_MODS, tr.op, { text: tr.text, head: tr.head }, rec.listHost).state;
        assert.deepStrictEqual({ text: again.text, head: again.head }, { text: tr.text, head: tr.head },
          '幂等扫描：无效果的 `' + tr.op + '` 连按两次结果不同。\n' + repro(rec, tr.step)
          + '\n  第一次后：' + JSON.stringify({ text: tr.text, head: tr.head })
          + '\n  第二次后：' + JSON.stringify({ text: again.text, head: again.head }));
      }
      prev = { text: tr.text, head: tr.head };
    });
  });
  assert.ok(steps > 5000, '幂等扫描覆盖不足：只走了 ' + steps + ' 步');
  assert.ok(noops > 1000, '幂等扫描里无效果步骤太少：' + noops + '（判据近似空跑）');
});

test('空项回车：不是「无效果」操作（产品契约是删标记退列表）——按真实契约判稳定性', function () {
  // ⚠️ 偏离说明（文件头也写了）：`input.js::lineBreakAction` 分支 ③ 规定「空 item 回车
  //    = 删标记退列表」。所以「连按两次 == 按一次」在这一档**不成立**：第一次删掉 `- `，
  //    第二次在空行上插入一个换行，都是真实效果。这里判它真正的契约：
  //    ① 第一次**只**删标记，⛔ 不多删正文；② 之后每次回车**只**加一行，⛔ 不复活列表标记。
  let st = { text: '- 甲\n- \n', head: 6 };
  const first = applyOp(DEFAULT_MODS, 'enter', st, true);
  assert.ok(first.edit, '空列表项上回车必须是一条真实事务（删标记）');
  assert.strictEqual(first.state.text, '- 甲\n\n',
    '第一次回车只删空项的 `- `，⛔ 不碰正文、⛔ 不多留一行');
  assert.strictEqual(first.state.head, 4);

  const second = applyOp(DEFAULT_MODS, 'enter', first.state, true);
  assert.strictEqual(second.state.text, '- 甲\n\n\n',
    '第二次回车只加一个换行（这就是 0305 症状里那条「多出来的行」）');
  const remaining = planOf(DEFAULT_MODS, second.state.text, true).listLines;
  assert.strictEqual(remaining.length, 1,
    '退列表后只剩第一项，⛔ 不许把删掉的空项标记又补回来（复活列表）');
  assert.strictEqual(remaining[0].kind, 'bullet', '第一项仍是列表项');
  assert.strictEqual(remaining[0].marker, '-', '第一项的标记必须原样保留');
});

// ── 不变式 3：不动点 ───────────────────────────────────────────────────────

test('不变式 3：不动点——任意序列之后「只重算装饰、不改文档」满足 f(f(x)) == f(x)', function () {
  const rs = records();
  let checked = 0;
  rs.forEach(function (rec) {
    const first = fingerprint(DEFAULT_MODS, rec.text, rec.listHost);
    assert.deepStrictEqual(first, rec.fp,
      '同一份终态文本重算两次装饰不一致。\n' + repro(rec, rec.seq.length)
      + '\n  第一次：' + JSON.stringify(rec.fp) + '\n  第二次：' + JSON.stringify(first));

    // 「只重算」还要接一次**无效果的文档事务**：光标推到文末按 ⌦，正文一个字节都不许动。
    const end = { text: rec.text, head: rec.text.length };
    const noop = applyOp(DEFAULT_MODS, 'deleteForward', end, rec.listHost);
    assert.strictEqual(noop.state.text, rec.text, '文末 ⌦ 竟然改了正文。\n' + repro(rec, rec.seq.length));
    assert.deepStrictEqual(fingerprint(DEFAULT_MODS, noop.state.text, rec.listHost), first,
      '无效果事务之后重算装饰变了（不动点破坏）。\n' + repro(rec, rec.seq.length));
    checked++;
  });
  assert.ok(checked > 5000, '不动点覆盖不足：只检查了 ' + checked + ' 个终态');
});

// ── 不变式 4：可逆性 ───────────────────────────────────────────────────────

/** 用产品输入状态机插入一段文字（⛔ 不手写插入逻辑）。 */
function insertText(mods, state, data) {
  const txs = [];
  const m = mods.I.createInputMachine(function (t) { txs.push(t); });
  const r = m.handle({ type: 'beforeinput', inputType: 'insertText', data: data,
    from: state.head, to: state.head });
  if (!r.applied || !txs.length) return null;
  const tx = txs[txs.length - 1];
  const next = tx.next.join('\n');
  return {
    text: state.text.slice(0, tx.from) + next + state.text.slice(tx.to),
    head: tx.from + next.length,
  };
}

/** 插入 k 字符 → 退格 k 次的用例。 */
function reversibilityCases(mods) {
  const cases = [];
  INITIAL.forEach(function (init) {
    const p = planOf(mods, init.text, init.listHost);
    const d = doc(init.text);
    const heads = [0, d.length];
    (p.listLines || []).forEach(function (li) { heads.push(li.contentFrom); });
    const seen = {};
    heads.forEach(function (h) {
      if (seen[h]) return;
      seen[h] = true;
      ['abc', '中文'].forEach(function (data) {
        cases.push({ init: init, head: h, data: data, k: Array.from(data).length });
      });
    });
  });
  return cases;
}

test('不变式 4a：插入 k 个字符 + 退格 k 次 ⇒ 回到逐字节原文档', function () {
  const cases = reversibilityCases(DEFAULT_MODS);
  assert.ok(cases.length > 20, '可逆性用例太少：' + cases.length);
  const res = checkInsertBackspace(
    function (st, data) { return insertText(DEFAULT_MODS, st, data); },
    function (st, listHost) { return applyOp(DEFAULT_MODS, 'backspace', st, listHost).state; },
    cases);
  assert.ok(res.ok, res.message);
});

test('不变式 4b：操作 + undo ⇒ 回到上一步（文档 + 光标，走真实 CM6 history）', function () {
  let checked = 0;
  INITIAL.forEach(function (init) {
    const p = planOf(DEFAULT_MODS, init.text, init.listHost);
    const d = doc(init.text);
    const heads = [0, d.length];
    (p.listLines || []).forEach(function (li) { heads.push(li.contentFrom); });
    const seen = {};
    heads.forEach(function (head) {
      if (seen[head]) return;
      seen[head] = true;
      OPS.forEach(function (op) {
        const r = applyOp(DEFAULT_MODS, op, { text: init.text, head: head }, init.listHost);
        if (!r.edit) return; // 无效果 ⇒ 没有可撤销的事务
        checked++;
        const e = r.edit;
        // `history()` ＋ `undo()` 是 `main.js` 装的产品撤销路径（`CM6.history` / `CM6.undo`）。
        // ⚠️ 每个用例用一份**新**历史，确保 undo 只退这一条事务（CM6 会按时间合并邻近改动）。
        let es = EditorState.create({
          doc: e.preText,
          extensions: [history()],
          selection: { anchor: e.preHead, head: e.preHead },
        });
        es = es.update({
          changes: { from: e.from, to: e.to, insert: e.insert },
          selection: { anchor: e.postHead },
        }).state;
        const where = '\n  初始文档：' + JSON.stringify(init.text)
          + '\n  光标：' + head + '（listHost=' + init.listHost + '）'
          + '\n  操作：' + op;
        assert.strictEqual(es.doc.toString(), e.postText, '操作后的文档与模块给出的事务不一致' + where);
        assert.strictEqual(es.selection.main.anchor, e.postHead, '操作后的光标不一致' + where);
        const ok = undo({ state: es, dispatch: function (tr) { es = tr.state; } });
        assert.strictEqual(ok, true, 'undo 没有可撤销的条目' + where);
        assert.strictEqual(es.doc.toString(), e.preText, 'undo 后文档没有回到上一步' + where);
        assert.strictEqual(es.selection.main.anchor, e.preHead, 'undo 后光标没有回到上一步' + where);
      });
    });
  });
  assert.ok(checked > 20, '撤销可逆性用例太少：' + checked);
});

// ── 变异自检：每条不变式都要能红 ───────────────────────────────────────────

test('变异 mS1：路径无关性判据能抓住「按路径记松紧」的替身', function () {
  // 一个**故意改错**的装饰判据：同一份文本，第二次给出不同的值（路径依赖）。
  // ⚠️ `design/0066` 起产品投影里没有 `listSepLines`；这里用一个**任意键名**的替身即可，
  //    判据比较的是"同一文本 → 同一指纹"，与键名无关。
  const wrong = [
    { initName: '紧无序列表', initText: '- 甲\n- 乙\n- 丙\n', listHost: true, head: 10,
      seq: ['enter', 'enter'], text: '- 甲\n- 乙\n\n- 丙\n', fp: { 假判据: [{ line: 2, from: 8 }] } },
    { initName: '紧无序列表', initText: '- 甲\n- 乙\n- 丙\n', listHost: true, head: 7,
      seq: ['enter', 'backspace'], text: '- 甲\n- 乙\n\n- 丙\n', fp: { 假判据: [] } },
  ];
  const bad = checkPathIndependence(wrong);
  assert.strictEqual(bad.ok, false, 'mS1 没红：路径依赖的替身竟然通过了');
  assert.match(bad.message, /路径无关性被破坏/);
  assert.match(bad.message, /初始文档/);
  assert.match(bad.message, /操作序列/);
  assert.match(bad.message, /预期/);
  assert.match(bad.message, /实际/);

  // 负对照：同一份判据喂**产品真实**的同文本路径 ⇒ 绿（至少 100 组碰撞已在不变式 1 里验过）。
  const real = checkPathIndependence(records().slice(0, 200));
  assert.strictEqual(real.ok, true, '负对照：产品真实装饰被判成路径依赖');
});

test('变异 mS2：幂等判据能抓住「每次多删一格」的替身', function () {
  const state = { text: '- 甲\n- 乙\n', head: 0 };
  const badApply = function (st) {
    // 故意改错：本该无效果，却每按一次吃掉一个字符。
    return { text: st.text.slice(0, Math.max(0, st.text.length - 1)), head: st.head };
  };
  const bad = checkNoOpTwice(badApply, state, '替身退格');
  assert.strictEqual(bad.ok, false, 'mS2 没红：每次多删一格的替身竟然通过了');
  assert.match(bad.message, /幂等被破坏/);

  const good = checkNoOpTwice(function (st) {
    return applyOp(DEFAULT_MODS, 'backspace', st, true).state;
  }, state, '产品退格');
  assert.strictEqual(good.ok, true, '负对照：产品在文首的 ⌫ 被判成不幂等');
});

test('变异 mS3：不动点判据能抓住「每次重算都变」的替身', function () {
  let tick = 0;
  const badRecompute = function () {
    tick++;
    return { 假判据: tick % 2 === 0 ? [] : [{ line: 1, from: 3 }] };
  };
  const bad = checkFixedPoint(badRecompute, [{ text: '- 甲\n\n- 乙\n', listHost: true }]);
  assert.strictEqual(bad.ok, false, 'mS3 没红：每次重算都变的替身竟然通过了');
  assert.match(bad.message, /不动点被破坏/);

  const good = checkFixedPoint(function (c) {
    return fingerprint(DEFAULT_MODS, c.text, c.listHost);
  }, [{ text: '- 甲\n\n- 乙\n', listHost: true }]);
  assert.strictEqual(good.ok, true, '负对照：产品装饰不是不动点');
});

test('变异 mS4：可逆性判据能抓住「退格少删一格」的替身', function () {
  const cases = reversibilityCases(DEFAULT_MODS).slice(0, 4);
  const bad = checkInsertBackspace(
    function (st, data) { return insertText(DEFAULT_MODS, st, data); },
    function (st) {
      // 故意改错：每次退格**少删一格**（模拟字素窗口算短了）。
      const p = planOf(DEFAULT_MODS, st.text, true);
      const d = doc(st.text);
      const r = DEFAULT_MODS.S.deleteRange(d, { anchor: st.head - 1, head: st.head - 1 },
        { forward: false, hidden: DEFAULT_MODS.S.protectedRanges({ state: { doc: d } },
          { plan: function () { return p; } }) });
      if (!(r.to > r.from)) return st;
      return { text: st.text.slice(0, r.from) + st.text.slice(r.to), head: r.from };
    },
    cases);
  assert.strictEqual(bad.ok, false, 'mS4 没红：少删一格的替身竟然通过了');
  assert.match(bad.message, /可逆性被破坏/);

  const good = checkInsertBackspace(
    function (st, data) { return insertText(DEFAULT_MODS, st, data); },
    function (st, listHost) { return applyOp(DEFAULT_MODS, 'backspace', st, listHost).state; },
    cases);
  assert.strictEqual(good.ok, true, '负对照：产品退格不可逆');
});

test('变异 mS5（真实源码）：摘掉 `backOverBlankLine` ⇒ 0305 的恢复判据必红', function () {
  const SEL_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'live', 'selection.js'), 'utf8');
  const target = '    const 空行反 = backOverBlankLine(doc, hidden, 起点);';
  assert.strictEqual(SEL_SRC.split(target).length - 1, 1, 'mS5 的靶子必须恰好命中 1 次');
  const mutated = SEL_SRC.replace(target, '    const 空行反 = null;');
  assert.notStrictEqual(mutated, SEL_SRC, 'mS5 没改到');
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'window', 'document', 'navigator', mutated)(mod, undefined, undefined, undefined);
  const mutMods = { D: DEFAULT_MODS.D, S: mod.exports, I: DEFAULT_MODS.I };

  const text = '- 甲\n- 乙\n\n- 丙\n';
  const plan = planOf(DEFAULT_MODS, text, true);
  const last = plan.listLines[plan.listLines.length - 1];

  const product = applyOp(DEFAULT_MODS, 'backspace', { text: text, head: last.contentFrom }, true);
  assert.strictEqual(product.state.text, '- 甲\n- 乙\n- 丙\n', '负对照：产品版必须恢复成紧列表');

  const broken = applyOp(mutMods, 'backspace', { text: text, head: last.contentFrom }, true);
  assert.notStrictEqual(broken.state.text, product.state.text,
    'mS5 没红：摘掉 backOverBlankLine 后仍回到了紧列表');
  assert.ok(broken.state.text.indexOf('\n\n') >= 0,
    'mS5 没红：摘掉 backOverBlankLine 后那条空行应当还在（0305 的"删不回去"）');
  assert.ok(broken.state.text.indexOf('- 丙') < 0,
    'mS5 没红：摘掉 backOverBlankLine 后按 ⌫ 应当吃掉 `- `（0305 的同一形态）');
});
