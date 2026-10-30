//! 朴素搜索（步骤 3 的基线）。
//!
//! ⚠️ **偏移契约**（`docs/design/0002` §2.3）：本模块返回的**一律是 UTF-8 字节偏移**
//! （相对源串）；换算到 UTF-16 码元是**展示层**的事，
//! 用 [`super::offset::byte_to_utf16_in_line`]。⛔ 不要在这里"顺手"返回码元偏移——
//! 那样上层就再也说不清拿到的是哪种了。
//!
//! ⛔ **V1 不做大小写不敏感搜索**：`str::to_lowercase()` 会改变字节长度
//! （`İ` 一个字符会变成 2 个），一旦在 lowercase 后的字符串上定位，
//! 偏移就对不回原文——正是本项目最怕的静默错位。要做就得逐字符建映射表，
//! 那是另一条设计决定，不在原型范围内。

use std::ops::Range;

use super::offset::LineIndex;

/// 一次命中。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// 源串上的字节区间。
    pub span: Range<usize>,
    /// 1-based 行号。
    pub line: usize,
    /// 行内 UTF-16 码元区间（已算好，给展示层直接用）。
    pub utf16_in_line: Range<usize>,
    /// 命中处前后各留一小段的摘录（用于列表展示）。
    pub excerpt: String,
}

/// 全部命中，**不重叠**，按出现顺序。
///
/// 空 `needle` 返回空——否则长度 0 的匹配会在每个字节边界上命中，把调用方淹掉。
pub fn find_all(src: &str, needle: &str, index: &LineIndex) -> Vec<Hit> {
    if needle.is_empty() {
        return Vec::new();
    }

    let mut hits = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = src[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        hits.push(make_hit(src, index, start, end));
        from = end;
    }
    hits
}

/// 从一个已知的字节区间构造命中信息。
pub fn make_hit(src: &str, index: &LineIndex, start: usize, end: usize) -> Hit {
    let line = line_of(index, start);
    let line_start = index.line_start(line).unwrap_or(0);
    let line_text = index.line_str(src, line).unwrap_or("");

    let utf16_in_line = {
        let a = super::offset::byte_to_utf16_in_line(line_text, start.saturating_sub(line_start))
            .unwrap_or(0);
        let b = super::offset::byte_to_utf16_in_line(line_text, end.saturating_sub(line_start))
            .unwrap_or(a);
        a..b
    };

    Hit { span: start..end, line, utf16_in_line, excerpt: excerpt(src, index, line, start, end) }
}

/// 二分找 `byte` 落在哪一行（1-based）。
///
/// ⚠️ 用二分而不是线性扫：搜索命中可能上万个，线性扫会变成 O(n·m)。
pub fn line_of(index: &LineIndex, byte: usize) -> usize {
    let mut lo = 1usize;
    let mut hi = index.line_count();
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        match index.line_start(mid) {
            Some(s) if s <= byte => lo = mid,
            _ => hi = mid - 1,
        }
    }
    lo
}

/// 摘录：命中处前后各截若干**字符**，**不跨行**。
///
/// ⚠️ 不跨行是有意的：搜索结果列表里一条命中占一行才读得下去；
/// 跨行的摘录也会把"命中在第几行"这条信息搞糊。
fn excerpt(src: &str, index: &LineIndex, line: usize, start: usize, end: usize) -> String {
    const AROUND: usize = 20;
    let line_start = index.line_start(line).unwrap_or(0);
    let line_end = line_start + index.line_str(src, line).map(str::len).unwrap_or(0);

    // 行内相对偏移
    let s_rel = start.saturating_sub(line_start);
    let e_rel = (end - line_start).min(line_end - line_start);

    let line_text = index.line_str(src, line).unwrap_or("");
    let s = char_floor(line_text, s_rel.saturating_sub(AROUND));
    let e = char_ceil(line_text, (e_rel + AROUND).min(line_text.len()));

    let mut out = String::new();
    if s > 0 {
        out.push('…');
    }
    out.push_str(&line_text[s..e].replace('\r', ""));
    if e < line_text.len() {
        out.push('…');
    }
    out
}

/// 向前退到字符边界。
fn char_floor(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// 向后走到字符边界。
fn char_ceil(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⭐ 主测试：命中位置在**中文**文档上必须对得上源串。
    ///
    /// `needle` 的长度不等于"字符数"，且前面有 3 字节中文——这正是
    /// "只在中文上出错"的那类偏移。断言一律拿**源子串**比对，不比数字，
    /// 因为数字对不对要看口径，而"切出来的就是原文"是无歧义的。
    #[test]
    fn 中文命中的字节区间能切出原文() {
        let src = "第一段中文。\n\n第二段里有「文档」这两个字。\n\n第三段。\n";
        let i = LineIndex::new(src);
        let hits = find_all(src, "文档", &i);

        assert_eq!(hits.len(), 1, "应该只命中一次");
        let h = &hits[0];
        assert_eq!(&src[h.span.clone()], "文档", "字节区间必须切出原文");
        assert_eq!(h.line, 3, "命中在源文件的第 3 行");
        // 行内 UTF-16：`第二段里有「文档」这两个字。` 里「文档」前有 6 个 BMP 字符
        assert_eq!(h.utf16_in_line, 6..8, "UTF-16 口径是每字符 1 个码元");
    }

    /// Emoji 在**行内**会让字节偏移与 UTF-16 偏移分道扬镳——
    /// 这是"中文和 Emoji 会定位错位"在搜索侧的最小复现。
    #[test]
    fn 行内含_emoji_时_utf16_与字节偏移不同() {
        let src = "🚀🇨🇳 文档\n";
        let i = LineIndex::new(src);
        let hits = find_all(src, "文档", &i);

        assert_eq!(hits.len(), 1);
        let h = &hits[0];
        assert_eq!(&src[h.span.clone()], "文档");
        // 字节：🚀=4 + 🇨🇳=8 + 空格=1 = 13
        assert_eq!(h.span.start, 13, "字节偏移把 emoji 算成 4 与 8");
        // UTF-16：🚀=2 + 🇨🇳=4 + 空格=1 = 7
        assert_eq!(h.utf16_in_line.start, 7, "UTF-16 把 emoji 算成 2 与 2");
        // ⛔ 两者不等——这就是必须显式换算的理由
        assert_ne!(h.span.start, h.utf16_in_line.start);
    }

    /// 空 `needle` 必须返回空：否则长度 0 的匹配会在每个字节边界上命中。
    #[test]
    fn 空_needle_返回空() {
        let src = "abc";
        let i = LineIndex::new(src);
        assert!(find_all(src, "", &i).is_empty());
    }

    /// 命中**不重叠**，且按出现顺序。
    #[test]
    fn 命中不重叠且按序() {
        let src = "aaaa";
        let i = LineIndex::new(src);
        let hits = find_all(src, "aa", &i);
        assert_eq!(hits.len(), 2, "`aa` 在 `aaaa` 上应命中 2 次（不重叠）");
        assert_eq!(hits[0].span, 0..2);
        assert_eq!(hits[1].span, 2..4);
    }

    /// 摘录**不跨行**——命中行有边界时，摘录不许把邻行的内容带进来。
    #[test]
    fn 摘录不跨行() {
        let src = "上一行的内容不应该出现\n命中「文档」在这一行\n下一行也不应该出现\n";
        let i = LineIndex::new(src);
        let hits = find_all(src, "文档", &i);
        assert_eq!(hits.len(), 1);
        let ex = &hits[0].excerpt;
        assert!(!ex.contains("上一行"), "摘录越界到上一行了：{ex:?}");
        assert!(!ex.contains("下一行"), "摘录越界到下一行了：{ex:?}");
        assert!(!ex.contains('\n'), "摘录里不许有换行");
        assert!(ex.contains("文档"), "摘录里得有命中本身：{ex:?}");
    }

    /// 文件末尾（无行尾换行）也要能命中——`line_str` 在末行没有"下一行"可参考。
    #[test]
    fn 末行无换行也能命中() {
        let src = "# 标题\n\n结尾处的文档";
        let i = LineIndex::new(src);
        let hits = find_all(src, "文档", &i);
        assert_eq!(hits.len(), 1);
        assert_eq!(&src[hits[0].span.clone()], "文档");
        assert_eq!(hits[0].line, 3);
    }
}

