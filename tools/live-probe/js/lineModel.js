'use strict';

// ⭐ `design/0047` §2.1 / §2.4 的**候选实现**（⛔ 不是产品代码，不接入产品路径）。
//
// 唯一全文模型 `fullText`：
// - 恒 **LF**、无 BOM（`EditGrant.text` 的保证，见 `docs/design/0047` §2.1）；
// - 索引空间 = **行号（1-based，含两端）＋ 行内 UTF-16**，⛔ 不用 UTF-8 字节偏移。
//
// 本文件只出**可运行证据**：产品侧的同一份逻辑将来落在 `src/services/`（IIFE 形态），
// 语义必须与这里逐条一致。

// ————————————————————————————————————————————————————————————————————————————
// 行模型
// ————————————————————————————————————————————————————————————————————————————

/** `fullText` → 行数组。⚠️ `'a\n'` 得到 `['a','']`——**末尾那个空串是真实的一行**。 */
function splitLines(text) {
  return text.split('\n');
}

function joinLines(lines) {
  return lines.join('\n');
}

/**
 * 1-based 含两端 ⇄ 0-based 半开。
 *
 * ⚠️ 这个换算是**全项目最容易差一的地方**：`sourcepos.end.line` 是**含**的（Python 口径），
 * 而 JS 的 `slice` 是**半开**的。⛔ 别在别处再写一次 `end + 1`。
 */
function toRange(startLine, endLine) {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    throw new Error('行号必须是整数');
  }
  if (startLine < 1 || endLine < startLine) {
    throw new Error(`行区间非法 ${startLine}-${endLine}`);
  }
  return { from: startLine - 1, to: endLine };
}

/**
 * 把 `lines[from, to)` 换成 `next`。
 *
 * ⚠️ 越界**抛错**，⛔ 不夹取：夹取会把"用旧行号提交"这个错误**静默**变成"改对了附近"。
 */
function applyEdit(lines, range, next) {
  const { from, to } = range;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > lines.length) {
    throw new Error(`区间越界 [${from},${to}) 于 ${lines.length} 行`);
  }
  return lines.slice(0, from).concat(next, lines.slice(to));
}

/**
 * 块表自检：合法、有序、不重叠、不越界。
 * ⚠️ 返回问题数组（空 = 通过），⛔ 不抛错——它是**判据**，不是守卫。
 */
function spanIssues(lineCount, blocks) {
  const issues = [];
  let cursor = 0; // 0-based 半开游标
  for (const b of blocks) {
    if (!Number.isInteger(b.start_line) || !Number.isInteger(b.end_line)) {
      issues.push(`块 ${b.index} 行号不是整数`);
      continue;
    }
    if (b.start_line < 1 || b.end_line < b.start_line) {
      issues.push(`块 ${b.index} 区间倒置 ${b.start_line}-${b.end_line}`);
      continue;
    }
    if (b.end_line > lineCount) {
      issues.push(`块 ${b.index} 右端 ${b.end_line} 超出 ${lineCount} 行`);
      continue;
    }
    if (b.start_line - 1 < cursor) {
      issues.push(`块 ${b.index} 与上一块重叠（起点 ${b.start_line}，游标 ${cursor + 1}）`);
    }
    cursor = Math.max(cursor, b.end_line);
  }
  return issues;
}

/** 块间行号（1-based）。⚠️ 就是 §2.8「光标不进、边界键不吞」的那批行。 */
function gapsOf(lineCount, blocks) {
  const covered = new Array(lineCount + 1).fill(false);
  for (const b of blocks) {
    for (let l = b.start_line; l <= b.end_line; l++) covered[l] = true;
  }
  const out = [];
  for (let l = 1; l <= lineCount; l++) if (!covered[l]) out.push(l);
  return out;
}

/** 命中某一行的顶层块（没有 ⇒ `null`）。 */
function locateBlock(blocks, line) {
  for (const b of blocks) {
    if (line >= b.start_line && line <= b.end_line) return b;
  }
  return null;
}

// ————————————————————————————————————————————————————————————————————————————
// 身份闸（§2.4 的四件套 ＋ commitSeq）
// ————————————————————————————————————————————————————————————————————————————

/**
 * 一条回包能不能被接受。
 *
 * ⚠️ **`line_count` 是判据的核心**：一次改变行数的提交之后，旧块表的行号会
 * **静默指向别的行**（证据见 `tools/live-probe` 的 `--fixtures`「陈旧行号」四条）。
 * ⇒ 行数变化就必须让在途请求全部作废，⛔ 不能只比 `docSeq`。
 */
function acceptReply(state, reply) {
  if (reply.doc_seq !== state.doc_seq) return { ok: false, why: 'doc_seq 不符（换文档了）' };
  if (reply.line_count !== state.line_count) {
    return { ok: false, why: `line_count 不符（${reply.line_count} ≠ ${state.line_count}，行号已陈旧）` };
  }
  if (reply.commit_seq < state.commit_seq) {
    return { ok: false, why: `commit_seq 倒退（${reply.commit_seq} < ${state.commit_seq}）` };
  }
  return { ok: true, why: '' };
}

/** 提交成功后推进状态（⛔ 只在这里推进，别在别处各写一份）。 */
function afterCommit(state, lineCount) {
  return {
    doc_seq: state.doc_seq,
    line_count: lineCount,
    commit_seq: state.commit_seq + 1,
  };
}

module.exports = {
  splitLines,
  joinLines,
  toRange,
  applyEdit,
  spanIssues,
  gapsOf,
  locateBlock,
  acceptReply,
  afterCommit,
};
