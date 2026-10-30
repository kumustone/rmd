//! 把 comrak 的 `(行, 列)` 换算成全局 UTF-8 字节偏移。
//!
//! **为什么需要它**（`docs/kb/0002-comrak-源码位置粒度.md`）：comrak 的 `Sourcepos`
//! 是**二维**的 `(line, column)`，而 `String::slice`、DOM 的 `Range`、搜索命中位置
//! 都是**一维**字节偏移。两者之间没有现成换算。
//!
//! ⚠️ **这是本项目最容易静默出错的地方**（根 `CLAUDE.md` §架构）。
//!
//! ## 列语义（2026-10-13 在 `comrak 0.56.0` 上**实测修正**）
//!
//! 上游 `src/parser/mod.rs:91` 的 `byte_col_to_char_col` 是唯一权威定义。把
//! `byte_col - 1` 当作**行内偏移**去数"起点 ≤ 它的字符个数"，由此可推出：
//!
//! | 字段 | 语义 |
//! |---|---|
//! | `sourcepos.start.column` | **起点**：`column - 1` = 行内该单位的偏移（闭） |
//! | `sourcepos.end.column` | **右开边界**：`column` 本身就是行内的"单位长度和"（开） |
//!
//! ⛔ **两者不是同一个口径！** 把它当"最后一个字符的列"去 `-1` 再 `+1`，
//! 在**纯英文文档上恰好也对**（因为 ASCII 一个字符一字节），
//! 而**中文文档上会切到字符中间**——正是本项目最怕的静默错位。
//! 实测：`# 中文标题` 的 `Text` 节点是 `start.column = 3, end.column = 14`，
//! 而 `中文标题` 只占 12 字节——`3` 和 `14` 的差不是 11 个字符，是"2 到 14 的字节"。
//!
//! 单位由 `ParseOpts::sourcepos_chars` 决定：默认 `Bytes`，`true` 时 `Chars`。

use std::ops::Range;

use comrak::nodes::Sourcepos;

/// comrak `column` 的计量单位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColUnit {
    /// 默认。一个中文字算 **3** 列，一个 emoji 算 4 列。
    Bytes,
    /// `ParseOpts::sourcepos_chars = true` 时。一个字符算 1 列。
    Chars,
}

/// 行起始字节偏移索引。
///
/// `starts[i]` = 第 `i+1` 行（1-based）的首字节在源串中的偏移。
///
/// ⚠️ **行分隔符只认 `\n`**：CRLF 文档里 `\r` 留在**行内容末尾**，不占行号。
/// 这与 comrak 一致（它的 `\r` 是行内容的一部分，但不影响任何列号）。
#[derive(Debug, Clone)]
pub struct LineIndex {
    starts: Vec<usize>,
    len: usize,
}

impl LineIndex {
    /// 建索引。O(n) 一遍扫，不分配额外的字符串。
    pub fn new(src: &str) -> Self {
        let bytes = src.as_bytes();
        let mut starts = Vec::with_capacity(bytes.len() / 40 + 1);
        starts.push(0);
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }
        Self { starts, len: bytes.len() }
    }

    /// 行数。⛔ 源串以 `\n` 结尾时会多出一行**空的**第 N+1 行——
    /// 那与"编辑器里光标能停到最后一行之后"是同一件事，不是 bug。
    pub fn line_count(&self) -> usize {
        self.starts.len()
    }

    /// 源串总字节数。
    pub fn len(&self) -> usize {
        self.len
    }

    /// 源串是否为空。
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// 第 `line` 行（1-based）的起始字节偏移。越界给 `None`。
    pub fn line_start(&self, line: usize) -> Option<usize> {
        if line == 0 {
            return None;
        }
        self.starts.get(line - 1).copied()
    }

    /// 第 `line` 行的内容（**不含**行尾 `\n`；CRLF 时**含** `\r`）。
    ///
    /// ⚠️ 行尾的 `\n` 必须切掉：comrak 的列号是以**不含行终止符**的行为基准算的
    /// （上游 `convert_sourcepos_columns_to_chars` 用的就是 `md.lines()`）。
    /// 不切的话，行内偏移会整体差一个字节，而行末的位置就会切到 `\n` 上去。
    pub fn line_str<'s>(&self, src: &'s str, line: usize) -> Option<&'s str> {
        let start = self.line_start(line)?;
        let end = match self.starts.get(line) {
            // `starts[line]` 是下一行的起点，也就是本行 `\n` **之后**
            Some(next) => next - 1,
            None => self.len,
        };
        src.get(start..end.max(start))
    }

    /// `sourcepos.start` → 全局字节偏移。
    pub fn start_offset(
        &self,
        src: &str,
        sp: &Sourcepos,
        unit: ColUnit,
    ) -> Option<usize> {
        let base = self.line_start(sp.start.line)?;
        let line = self.line_str(src, sp.start.line)?;
        Some(base + unit_offset_in_line(line, sp.start.column.checked_sub(1)?, unit, false)?)
    }

    /// `sourcepos.end` → 全局右开字节边界。
    ///
    /// ⛔ 注意入参**不减一**——`end.column` 自己就是右开边界，这是本文件的核心结论。
    pub fn end_offset(&self, src: &str, sp: &Sourcepos, unit: ColUnit) -> Option<usize> {
        let base = self.line_start(sp.end.line)?;
        let line = self.line_str(src, sp.end.line)?;
        Some(base + unit_offset_in_line(line, sp.end.column, unit, true)?)
    }

    /// `Sourcepos` → 半开字节区间 `[start, end)`。
    pub fn span(&self, src: &str, sp: &Sourcepos, unit: ColUnit) -> Option<Range<usize>> {
        let s = self.start_offset(src, sp, unit)?;
        let e = self.end_offset(src, sp, unit)?;
        if s > e || e > self.len {
            return None;
        }
        Some(s..e)
    }

    /// `Sourcepos` → 源串切片。
    pub fn slice<'s>(&self, src: &'s str, sp: &Sourcepos, unit: ColUnit) -> Option<&'s str> {
        src.get(self.span(src, sp, unit)?)
    }
}

/// 行内的"单位偏移" → 行内字节偏移。
///
/// `unit_index` 的含义随 `is_end` 变化（见模块头的表）：
/// - `is_end = false`（start 用）：`unit_index` = 起点所在单位的**下标**
/// - `is_end = true` （end 用） ：`unit_index` = 右开边界，即"到哪为止"
///
/// `Bytes` 时 `unit_index` 本身就是字节偏移（`is_end` 不影响），
/// 但**仍然要检查它落在字符边界上**——落在字符中间说明口径用错了，
/// 那时宁可 `None` 也不能静默取整。
fn unit_offset_in_line(line: &str, unit_index: usize, unit: ColUnit, _is_end: bool) -> Option<usize> {
    match unit {
        ColUnit::Bytes => {
            // comrak 会把"行尾之后"的位置也编码进来（见上游 `byte_col_to_char_col`
            // 对 `byte_col > line.len()` 的处理），这里同样按"行内容末尾"收口。
            let off = unit_index.min(line.len());
            if line.is_char_boundary(off) { Some(off) } else { None }
        }
        ColUnit::Chars => {
            let n_chars = line.chars().count();
            let idx = unit_index.min(n_chars);
            if idx == 0 {
                return Some(0);
            }
            match line.char_indices().nth(idx) {
                // 第 idx 个字符的起点
                Some((b, _)) => Some(b),
                // idx == n_chars：行内容末尾
                None if idx == n_chars => Some(line.len()),
                None => None,
            }
        }
    }
}

/// 把「行内 UTF-8 字节偏移」换算成「行内 UTF-16 码元偏移」。
///
/// 为什么需要：`design/0002` §2.3 的搜索映射契约——Rust 侧一律 UTF-8 字节偏移，
/// **展示层**（DOM `Range` / `Selection` / `Text` 节点偏移）一律 UTF-16 码元。
/// 两者对 BMP 之外的字（emoji）不一致，这正是"只在中文/Emoji 上出错"的来源。
pub fn byte_to_utf16_in_line(line: &str, byte_offset_in_line: usize) -> Option<usize> {
    let prefix = line.get(..byte_offset_in_line)?;
    Some(prefix.encode_utf16().count())
}

/// 把「行内 UTF-16 码元偏移」换算回「行内 UTF-8 字节偏移」。
///
/// ⭐ **`design/0054` 起它是 `byte_to_utf16_in_line` 的反向那一半**：
/// 前端（JS 的 `String#slice`）与单元格区间表都是 UTF-16 口径，
/// 而后端要动源码字节时必须换回来——`INV-EDITOBJ-03`「后端按基线自己造候选」就靠它。
///
/// ⚠️ **落在代理对中间 ⇒ `None`**（⛔ 不静默取整）：那说明调用方的偏移口径已经错了，
/// 取整会造出一份"看起来对、实际切进 emoji 中间"的候选。
pub fn utf16_to_byte_in_line(line: &str, utf16_offset_in_line: usize) -> Option<usize> {
    let mut acc = 0usize;
    for (byte, ch) in line.char_indices() {
        if acc == utf16_offset_in_line {
            return Some(byte);
        }
        if acc > utf16_offset_in_line {
            return None;
        }
        acc += ch.len_utf16();
    }
    // 行尾（含"偏移等于本行码元总数"这个合法终点）
    (acc == utf16_offset_in_line).then_some(line.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use comrak::Arena;

    fn idx(src: &str) -> LineIndex {
        LineIndex::new(src)
    }

    #[test]
    fn 行起始偏移_含末尾空行() {
        let i = idx("a\nbb\n");
        assert_eq!(i.line_count(), 3);
        assert_eq!(i.line_start(1), Some(0));
        assert_eq!(i.line_start(2), Some(2));
        assert_eq!(i.line_start(3), Some(5));
        assert_eq!(i.line_start(4), None);
    }

    #[test]
    fn crlf_时_r_留在行内容末尾() {
        let i = idx("a\r\nbb\r\n");
        assert_eq!(i.line_count(), 3);
        assert_eq!(i.line_str("a\r\nbb\r\n", 1), Some("a\r"));
        assert_eq!(i.line_str("a\r\nbb\r\n", 2), Some("bb\r"));
    }

    /// ⭐ 这条是**主测试**：中文文档上 start 与 end 的口径不同。
    #[test]
    fn 中文标题_字节口径_start_与_end_不同() {
        let src = "# 中文标题\n";
        let arena = Arena::new();
        let opts = crate::document::parser::ParseOpts::default();
        let root = crate::document::parser::parse(&arena, src, &opts);
        let i = idx(src);

        let mut checked = 0;
        for node in root.descendants() {
            let data = node.data();
            let sp = data.sourcepos;
            assert!(i.slice(src, &sp, ColUnit::Bytes).is_some(), "换算失败：{sp:?}");
            checked += 1;
        }
        assert!(checked >= 2, "至少应该有 Document 与 Heading 两个节点");

        // Heading：`# 中文标题`（14 字节）
        let sp = heading_sp(root);
        assert_eq!((sp.start.column, sp.end.column), (1, 14), "上游列语义变了");
        assert_eq!(i.slice(src, &sp, ColUnit::Bytes), Some("# 中文标题"));

        // ⭐ Text：`中文标题`。start 是"起点"（3 ⇒ 偏移 2），
        // end 是"右开边界"（14 ⇒ 偏移 14）。**两者口径不同**，
        // 把 end 减一当起点就会切在 `题` 的第二个字节上。
        let tsp = text_child_sp(root);
        assert_eq!((tsp.start.column, tsp.end.column), (3, 14), "上游列语义变了");
        assert_eq!(i.slice(src, &tsp, ColUnit::Bytes), Some("中文标题"));
        assert_ne!(src.is_char_boundary(14 - 1), true, "错读能被字符边界检查抓住");
    }

    /// 字符口径下：同一段文本的列号变成 3–6（`中文标题` 是 4 个字符，
    /// 但行首是 `# ` 两字符，所以 3..6）。⛔ 数值与字节口径完全不同。
    #[test]
    fn 字符口径的列号与字节口径不同_且混用会被抓住() {
        let src = "# 中文标题\n";
        let arena = Arena::new();
        let byte_opts = crate::document::parser::ParseOpts::default();
        let char_opts = crate::document::parser::ParseOpts { sourcepos_chars: true, ..Default::default() };
        let i = idx(src);

        let byte_root = crate::document::parser::parse(&arena, src, &byte_opts);
        let byte_sp = text_child_sp(byte_root);

        let char_arena = Arena::new();
        let char_root = crate::document::parser::parse(&char_arena, src, &char_opts);
        let char_sp = text_child_sp(char_root);

        assert_eq!((byte_sp.start.column, byte_sp.end.column), (3, 14));
        assert_eq!((char_sp.start.column, char_sp.end.column), (3, 6));

        // 各自用自己的单位 → 都对
        assert_eq!(i.slice(src, &byte_sp, ColUnit::Bytes), Some("中文标题"));
        assert_eq!(i.slice(src, &char_sp, ColUnit::Chars), Some("中文标题"));

        // ⛔ 混用 → 字符口径的列号当成字节偏移，落在 `标` 的中间 → 换算失败。
        // 这正是"口径用错时要么报错、要么静默错位"里的**报错**那条路；
        // 纯 ASCII 文档上则连报错都没有。
        assert_eq!(i.slice(src, &char_sp, ColUnit::Bytes), None);
    }

    fn heading_sp<'a>(root: &'a comrak::nodes::AstNode<'a>) -> comrak::nodes::Sourcepos {
        root.descendants()
            .find(|n| matches!(n.data().value, comrak::nodes::NodeValue::Heading(_)))
            .expect("有 Heading")
            .data()
            .sourcepos
    }

    fn text_child_sp<'a>(root: &'a comrak::nodes::AstNode<'a>) -> comrak::nodes::Sourcepos {
        let h = root
            .descendants()
            .find(|n| matches!(n.data().value, comrak::nodes::NodeValue::Heading(_)))
            .expect("有 Heading");
        h.descendants()
            .find(|n| matches!(n.data().value, comrak::nodes::NodeValue::Text(_)))
            .expect("Heading 里有 Text")
            .data()
            .sourcepos
    }

    #[test]
    fn utf16_换算_emoji_不是一换一() {
        let line = "a🚀b";
        // 字节：a=1, 🚀=4, b=1
        assert_eq!(byte_to_utf16_in_line(line, 0), Some(0));
        assert_eq!(byte_to_utf16_in_line(line, 1), Some(1));
        assert_eq!(byte_to_utf16_in_line(line, 5), Some(3)); // 🚀 占 2 个 UTF-16 码元
        assert_eq!(byte_to_utf16_in_line(line, 6), Some(4));
        // 切在字符中间 → None，不静默
        assert_eq!(byte_to_utf16_in_line(line, 2), None);
    }
}
