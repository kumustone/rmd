//! 目录（大纲）抽取 + 标题 ID 分配。
//!
//! ⚠️ **ID 必须文档级统一分配**（`docs/adr/0003`）：各块独立生成的话，
//! 分块渲染一上线锚点立刻错乱。
//!
//! 分配算法直接用 comrak 的 [`Anchorizer`]（GFM 算法：小写化 → 只留字母/数字/
//! 标记/连接符/空格-连字符 → 重名加 `-1` `-2`）。**理由是不重复发明**：
//! 中文标题经 `finl_unicode` 的 `is_letter()` 判定为字母，因此 CJK 字符**会保留**
//! 在 ID 里（`## 中文标题` → `中文标题`），不会变成空串。
//!
//! ⚠️ 另一条路是让 comrak 自己输出 `id`（`extension.header_id_prefix = Some("")`），
//! 代价是它**同时**会给每个标题套一个
//! `<a href="#id" aria-label="Link to heading '…'" data-heading-content="…">`。
//! 两条路都留着，谁更划算由 `design/0002` §7.0 步骤 3 的 HTML 体积数据决定。

use std::ops::Range;

use comrak::nodes::{AstNode, NodeValue};
use comrak::Anchorizer;

use super::offset::{ColUnit, LineIndex};

/// 一条目录项。
#[derive(Debug, Clone)]
pub struct TocEntry {
    /// 标题级别，1–6。
    pub level: u8,
    /// 标题的纯文本（已剥掉 `#` 与行内标记）。
    pub text: String,
    /// 文档内唯一的锚点 ID。
    pub id: String,
    /// 标题节点在源串里的字节区间（含 `#`）。
    pub span: Range<usize>,
    /// 该区间所处的 1-based 行号，给"跳转到源码行"用。
    pub line: usize,
}

/// 抽取目录。
///
/// `unit` 必须和解析时的 `ParseOpts::col_unit()` 一致，
/// 否则中文标题的 `span` 会整体错位（⚠️ 静默错位，不是报错）。
pub fn build<'a>(
    root: &'a AstNode<'a>,
    src: &str,
    index: &LineIndex,
    unit: ColUnit,
) -> Vec<TocEntry> {
    let mut anchorizer = Anchorizer::new();
    let mut out = Vec::new();

    for node in root.descendants() {
        let data = node.data();
        let NodeValue::Heading(h) = &data.value else {
            continue;
        };
        let level = h.level;
        let sourcepos = data.sourcepos;
        drop(data);

        let text = node.collect_text();
        let id = anchorizer.anchorize(&text);
        let span = index.span(src, &sourcepos, unit);

        out.push(TocEntry {
            level,
            text,
            id,
            span: span.unwrap_or(0..0),
            line: sourcepos.start.line,
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::parser::{with_parsed, ParseOpts};

    /// 从渲染出的 HTML 里按出现顺序抓出全部 `id="…"`。
    ///
    /// ⚠️ 只抓 `id="`（带前导空白），⛔ 不抓 `href="#…"`——comrak 开
    /// `heading_ids` 时会给每个标题套一个 `<a href="#id" …>`，
    /// 那里面也有一个 `#` 开头的字符串，但它**不是** `id` 属性。
    fn ids_in_html(html: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = html;
        while let Some(i) = rest.find(" id=\"") {
            let after = &rest[i + 5..];
            let end = after.find('"').expect("属性值一定闭合");
            out.push(after[..end].to_owned());
            rest = &after[end + 1..];
        }
        out
    }

    /// ⭐ **`INV-TOC-01`（`design/0007` §7.2 第 8 条）**：本模块算出的 id
    /// 与 comrak 自渲染的 `id=` **逐字相同**。
    ///
    /// ⚠️ **为什么这条必须有**：`design/0007` 给 `toc.rs` 的唯一承诺是
    /// **"行为一个字不改"**——而 `math_dollars` 一开，含公式的标题就换了一条
    /// 取文字的路径（`NodeValue::Math` 的 literal），`toc.rs` 却什么都没动。
    /// 于是"它还对不对"就只剩**书面保证**：这条断言就是那份保证
    /// （`notes/0009` §2.7 的 24/24 对照，这里把它固化成回归）。
    ///
    /// ⚠️ 样本**故意同时含**四类：中文标题、公式标题、同名重复标题、
    /// 带标点/空格的标题——`Anchorizer` 的四种行为各踩一次。
    #[test]
    fn 目录_id_与正文_id_同源() {
        let src = "# 中文标题\n\n\
                   ## $a + b$\n\n\
                   ## 非公式标题\n\n\
                   ## 中文标题\n\n\
                   ### 带 空格、标点！的标题\n\n\
                   #### Hello, World!\n\n\
                   ##### $x$\n\n\
                   ###### 中文标题\n";
        let opts = ParseOpts { heading_ids: true, ..Default::default() };

        let (toc_ids, html) = with_parsed(src, &opts, |root| {
            let index = LineIndex::new(src);
            let ids = build(root, src, &index, opts.col_unit())
                .into_iter()
                .map(|e| e.id)
                .collect::<Vec<_>>();
            (ids, crate::document::render::to_html(root, &opts))
        });

        let html_ids = ids_in_html(&html);

        assert_eq!(html_ids.len(), 8, "样本里有 8 个标题\n{html}");
        assert_eq!(
            toc_ids, html_ids,
            "⛔ INV-TOC-01：目录 id 与 comrak 自渲染的 id 不一致 ⇒ 点目录会跳不到\n{html}"
        );
        // ⚠️ 反面锚点：不能靠"两边都是空串"通过。
        assert!(
            toc_ids.iter().all(|id| !id.is_empty()),
            "id 不该有空串（中文标题经 finl_unicode 判定为字母，会保留）：{toc_ids:?}"
        );
        // ⚠️ 同名标题必须被加后缀区分，⛔ 不能两个都是 `中文标题`。
        let dup = toc_ids.iter().filter(|id| id.starts_with("中文标题")).count();
        assert_eq!(dup, 3, "三处同名标题都要有自己的 id：{toc_ids:?}");
        assert!(
            toc_ids[0] != toc_ids[3] && toc_ids[3] != toc_ids[7],
            "同名标题的后缀必须互不相同：{toc_ids:?}"
        );
    }
}
