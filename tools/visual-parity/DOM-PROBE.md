# DOM-PROBE.md —— rmd 侧 DOM 度量探针的输出契约

本文件说明 [`dom-probe.js`](dom-probe.js) 的加载方式、输出结构、每个量的口径与来源。
**口径的上游是设计文档，不是本文件**：
`docs/design/0063-Mardo-端侧对照测试.md` §2.6「双路显示行模型（D1）」与 §2.8「量法目录（M1–M8）」。
本文件只描述「脚本实际吐什么」。

---

## 1. 加载与调用

```html
<!-- 必须在正文挂载完成之后注入；它是经典脚本，⛔ 不是 ES module -->
<script src="tools/visual-parity/dom-probe.js"></script>
<script>
  // ⚠️ 只读：不写页面、不发事件、不联网
  const result = window.__PARITY_DOM.collect();
  // result 是 plain JSON 对象，可直接 JSON.stringify
</script>
```

| 导出 | 说明 |
|---|---|
| `window.__PARITY_DOM.schema` | `"rmd-parity-dom-probe/1"`，每次不兼容变更才升 |
| `window.__PARITY_DOM.version` | 探针版本号 |
| `window.__PARITY_DOM.DEFAULT_TOP_TOLERANCE_PX` | 行盒按 `top` 去重的默认容差（`0.5` CSS px） |
| `window.__PARITY_DOM.collect(options?)` | 采集一次，返回 plain JSON 对象 |

`collect(options)`：

- `options.topTolerancePx`（number，可选）：行盒按 `top` 去重的容差，默认 `0.5`。
  只影响 `line_boxes`，不影响其它几何量。

**约定**：

- 所有几何量一律是 **CSS px**，⛔ 不换算成 pt。
- 缺元素 / 无法测量时给 **`null`**，⛔ 不给 `0`；原因写进顶层的 `diagnostics`。
- 每个叶子量都带 `source`（或 `source` 映射），取值见 §3。
- 探针只读 DOM：`getComputedStyle`、`getBoundingClientRect`、`Range.getClientRects`、元素属性。
- 不依赖 rmd 的任何全局对象；只要页面上有 `.doc` 就能跑。

---

## 2. 顶层结构

```jsonc
{
  "schema": "rmd-parity-dom-probe/1",
  "probe_version": "1.0.0",
  "collected_at": "2026-11-08T04:20:00.000Z",
  "viewport": {
    "inner_width_px": 1000,
    "inner_height_px": 801,
    "device_pixel_ratio": 2
  },
  "doc": {
    "found": true,
    "selector": ".doc",
    "tag": "main",
    "id": "doc",
    "classes": ["doc"],
    "rect": { "top": 0, "left": 0, "right": 1000, "bottom": 2000, "width": 1000, "height": 2000 },

    "env": { /* §2.1 环境三字段 */ },
    "line_boxes": { /* §2.2 DOM 行盒数 + 按块明细 */ },
    "headings": { "h1": [/*…*/] | null, "h2": …, "h6": null },
    "lists": { /* §2.4 */ } | null,
    "blockquotes": { /* §2.5 */ } | null,
    "code_blocks": { /* §2.6 */ } | null,
    "tables": { /* §2.7 */ } | null,
    "task_items": { /* §2.8 */ } | null,
    "images": { /* §2.9 */ } | null,
    "inline": { "code": …, "em": …, "strong": …, "del": …, "links": … },
    "breaks": { /* §2.11 */ } | null,
    "rules": { /* §2.11 */ } | null
  },
  "diagnostics": [
    { "code": "missing-element", "category": "headings.h4", "message": ".doc 内没有 <h4>" }
  ]
}
```

`.doc` 不存在时：`doc.found = false`，`doc` 下所有度量字段为 `null`，
`diagnostics` 里有一条 `code = "doc-missing"`。

---

## 2.1 `doc.env` —— 环境三字段

| 字段 | 口径 | 来源 |
|---|---|---|
| `font_size_px` | `.doc` 的 computed `font-size` | computed style |
| `line_height_px` | `.doc` 的 computed `line-height`（`"normal"` → `null` + 诊断） | computed style |
| `line_height_raw` | 原样 computed 字符串，便于判断是否 `"normal"` | computed style |
| **`content_box_width_px`** | **`clientWidth − paddingLeft − paddingRight`** | computed style / clientWidth |
| `client_width_px` | `element.clientWidth` | `clientWidth` |
| `padding_left_px` / `padding_right_px` | computed padding | computed style |
| `padding_top_px` / `padding_bottom_px` | computed padding | computed style |
| `border_left_px` / `border_right_px` | computed border-width | computed style |
| `border_box_width_px` | `getBoundingClientRect().width`，**仅作参照** | `getBoundingClientRect` |
| `content_box_crosscheck_px` | `rect.width − 左右边框 − 左右内边距`，用于核对主口径 | `getBoundingClientRect` |
| `content_box_left_px` | `rect.left + borderLeft + paddingLeft`；列表缩进的基准 | `getBoundingClientRect` + computed |
| `content_box_right_px` | `rect.right − borderRight − paddingRight` | `getBoundingClientRect` + computed |

⭐ **正文内容列宽只认 `content_box_width_px`**（§2.8 U8 / D10）。⛔ 不要用
`border_box_width_px` 代替——那会把左右 padding 算进去。

---

## 2.2 `doc.line_boxes` —— DOM 行盒数（P-ENV-06 唯一口径）

```jsonc
{
  "count": 19,
  "dom_line_boxes": 19,
  "method": "Range.getClientRects() 逐个文本节点；只保留 width > 0；按 top 去重合并",
  "top_tolerance_px": 0.5,
  "source": "Range.getClientRects",
  "text_node_count": 54,
  "rect_count_total": 32,
  "zero_width_rects": 2,
  "by_block_sum": 21,
  "lines": [
    { "top": 36.75, "bottom": 69.75, "left": 20, "right": 205.44,
      "width": 185.44, "height": 33, "rect_count": 1, "blocks": [0] }
  ],
  "by_block": [
    { "index": 0, "top_level_index": 0, "tag": "h1", "classes": [],
      "display": "block", "path": ".doc > h1", "count": 1,
      "lines": [ { "top": 36.75, "bottom": 69.75, "left": 20, "right": 205.44,
                   "width": 185.44, "height": 33, "rect_count": 1 } ] }
  ]
}
```

### 算法（严格按 §2.6）

1. `TreeWalker` 遍历 `.doc` 下所有文本节点（跳过 `<script>` / `<style>` /
   `<template>` / `<noscript>`）。
2. 对每个文本节点 `Range.selectNodeContents(node).getClientRects()`。
3. **只保留 `width > 0` 的 rect** ⇒ 块内空行 / 纯空白产生的 0 宽 rect 不计数。
4. 按 `top` 去重合并：`|top₁ − top₂| ≤ top_tolerance_px`（默认 `0.5`）视为同一行；
   同一行的 `left/right/bottom` 取并集，`rect_count` 记合并了多少个 rect。
5. `count` / `dom_line_boxes` = 合并后的行盒数（两者是同一个数；后者字段名
   对齐 `fixtures-expect.json`）。这就是 `fixtures-expect.json` 的 `dom_line_boxes`。

### `count` vs `by_block_sum`

- `count` 是**全局**行盒数（跨块按 `top` 合并）。
- `by_block_sum` 是**逐块**行盒数之和。
- 二者可以不等。典型例子：表格同一行的多个单元格，全局按 `top` 合并成 1 个行盒，
  但每个单元格各自算 `1` ⇒ `by_block_sum > count`。
- `⚠️` **做 `P-ENV-06` 相等判定只能用 `count`**；`by_block_sum` 只用于定位。

### `by_block` 的分组规则

- 「块」= 文本节点向上找到的**最近 block-ish 祖先**（`block` / `list-item` /
  `table-cell` / `inline-block` / `flex` / `grid` 等），再上就是 `.doc`。
- 文本节点全部 0 宽的容器（例如块之间的纯空白）**不会**产生条目 ⇒ `count` 不会出现 0。
- 每个条目带 `path`（如 `.doc > ul:nth-of-type(1) > li:nth-of-type(2) > p`），
  `top_level_index` 指向它在 `.doc` 的直接子节点序号，便于定位。
- `lines[].blocks` 记录该全局行盒由哪些 `by_block[].index` 贡献。

---

## 2.3 `doc.headings`

```jsonc
"h1": [{
  "index": 0, "level": 1, "text": "Heading one",
  "path": ".doc > h1",
  "font_size_px": 28, "line_height_px": 30.8, "line_height_raw": "30.8px",
  "font_weight": "700",
  "ink":  { "top": 36.75, "left": 20, "right": 205.44, "bottom": 69.75,
            "width": 185.44, "height": 33, "rect_count": 1,
            "zero_width_rects": 0, "source": "Range.getClientRects" },
  "box":  { "top": 38.75, "left": 20, "right": 620, "bottom": 69.55,
            "width": 600, "height": 30.8 },
  "margin_top_px": 18.76, "margin_bottom_px": 18.76,
  "source": { "font_size_px": "computed style", "ink.*": "Range.getClientRects",
              "box.*": "getBoundingClientRect", "margin_*": "computed style" }
}]
```

- **墨迹盒** = 对标题内容取 Range rect 并集（`ink`），**盒子** = 元素的
  `getBoundingClientRect`（`box`）。两者不同：`box.height` 是行高盒，
  `ink.height` 是文本 rect 的并集高度。
- `h1`–`h6` 各自是数组或 `null`；没有该级标题时为 `null` + 一条诊断。

---

## 2.4 `doc.lists`

```jsonc
{
  "count": 7,
  "items": [{
    "index": 0, "level": 1,
    "path": ".doc > ul > li:nth-of-type(1)",
    "parent_list_tag": "ul",
    "list_style_type": "disc",
    "rect": { "top": 354.51, "left": 60, "right": 620, "bottom": 370.51,
              "width": 560, "height": 16 },
    "indent_px": 40,
    "source": {
      "rect.left": "getBoundingClientRect",
      "indent_px": "getBoundingClientRect − .doc content box 左缘",
      "list_style_type": "computed style"
    }
  }],
  "levels": [
    { "level": 1, "count": 6, "indent_px_min": 40, "indent_px_max": 40,
      "indent_px_median": 40 }
  ],
  "reference": "缩进 = li.getBoundingClientRect().left − .doc content box 左缘（CSS px）"
}
```

- `level` = 该 `li` 的祖先 `ul/ol` 个数（外层 `li` = 1，逐层 +1）。
- `indent_px` 的基准是 `.doc` 的 **content box 左缘**（`env.content_box_left_px`），
  ⛔ 不是视口左边、⛔ 不是 border box。
- `levels` 是逐层汇总，可直接看「每层缩进是否一致」。

---

## 2.5 `doc.blockquotes`

```jsonc
{
  "count": 1,
  "items": [{
    "index": 0, "path": ".doc > blockquote", "depth": 0,
    "bar": {
      "effective_width_px": 4,
      "border_left_width_px": 4,
      "border_left_style": "solid",
      "pseudo_before": { "content": "none", "display": "inline",
                         "rendered": false, "width_px": null,
                         "height_px": null, "source": "computed style" }
    },
    "padding_left_px": 7, "padding_right_px": 7,
    "line_height_px": 22.4,
    "rect": { "top": 491.47, "left": 60, "right": 580,
              "bottom": 555.86, "width": 520, "height": 64.39 },
    "source": { "bar.border_left_width_px": "computed style",
                "padding_*": "computed style", "line_height_px": "computed style",
                "rect": "getBoundingClientRect" }
  }]
}
```

- 产品当前用 `border-left` 画引用条 ⇒ `bar.effective_width_px` 取
  `border-left-width`。
- 同时读 `::before` 的 computed `content/width`；若某天改成伪元素画条，
  `effective_width_px` 会自动落到伪元素宽度（`rendered === true` 时）。
- `depth` = 祖先 `<blockquote>` 个数（嵌套层数，最外层 = 0）。

---

## 2.6 `doc.code_blocks`

```jsonc
{
  "count": 1,
  "items": [{
    "index": 0, "path": ".doc > pre",
    "pre_padding":  { "top": 0, "right": 0, "bottom": 0, "left": 0 },
    "code_padding": { "top": 10, "right": 12, "bottom": 10, "left": 12 },
    "font_size_px": 13, "line_height_px": 19.5, "line_height_raw": "19.5px",
    "font_family": "monospace", "white_space": "pre",
    "pre_rect":  { "top": 569.86, "left": 20, "right": 620,
                   "bottom": 648.36, "width": 600, "height": 78.5 },
    "code_rect": { "top": 569.86, "left": 20, "right": 620,
                   "bottom": 648.36, "width": 600, "height": 78.5 }
  }]
}
```

- 产品把字号 / 行高 / 内边距放在内层 `<pre><code>` 上，`pre` 自己只有底色与圆角
  （见 `src/styles/typography.css`）。因此 `font_size_px` / `line_height_px` /
  `code_padding` 取 `code` 的 computed 值；`pre_padding` 单独给 `pre` 的。
- `white_space` 取 `pre` 的 computed 值（横向滚动不换行的判定依据）。

---

## 2.7 `doc.tables`

```jsonc
{
  "count": 1,
  "items": [{
    "index": 0, "path": ".doc > table",
    "row_count": 2, "column_count": 2,
    "header_row_height_px": 35.39, "header_measured_from": "thead",
    "table_rect": { "top": 648.36, "left": 20, "right": 122.88,
                    "bottom": 720.14, "width": 102.88, "height": 71.78 },
    "columns": [
      { "index": 0, "width_px": 55.16, "ratio": 0.5414,
        "header_text": "Alpha", "colspan": 1 },
      { "index": 1, "width_px": 46.72, "ratio": 0.4586,
        "header_text": "Beta", "colspan": 1 }
    ]
  }]
}
```

- 列宽取**测量行**（优先 `thead` 第一行；没有表头则取第一行）每个 cell 的
  `getBoundingClientRect().width`。
- `ratio` = 该列宽 / 测量行所有 cell 宽度之和。
- `header_row_height_px` 是表头行 `tr` 的 rect 高度；没有表头时为 `null`。
- ⚠️ 产品 `.doc table` 是 `display: block; overflow-x: auto`；超宽表会横向滚动，
  cell 的 rect 宽度仍是布局宽度，不受视口裁剪影响。

---

## 2.8 `doc.task_items`

```jsonc
{
  "count": 2,
  "items": [{
    "index": 0,
    "path": ".doc > ul > li.task-list-item > input",
    "checked": true, "disabled": true,
    "rect": { "top": 737.14, "left": 64, "right": 77,
              "bottom": 750.14, "width": 13, "height": 13 },
    "width_px": 13, "height_px": 13, "margin_right_px": 3
  }]
}
```

- 优先匹配 `li.task-list-item input[type=checkbox]`；没有该 class 时回退到
  「祖先里有 `<li>` 的 checkbox」。
- `checked` / `disabled` 读 DOM property，不读 attribute。

---

## 2.9 `doc.images`

```jsonc
{
  "count": 1,
  "items": [{
    "index": 0, "path": ".doc > p > img",
    "src": "…", "alt": "pic",
    "rect": { "top": 792.92, "left": 20, "right": 84,
              "bottom": 856.92, "width": 64, "height": 64 },
    "natural_width_px": 64, "natural_height_px": 64, "complete": true
  }]
}
```

- `rect` 是渲染尺寸；`natural_*` 是图片固有尺寸。未加载完成时
  `complete = false`，`natural_*` 可能是 `0`（这是「没加载」的事实，不是缺元素）。

---

## 2.10 `doc.inline`

```jsonc
{
  "code":   [ { "index": 0, "tag": "code", "text": "inline-code",
                "path": ".doc > p:nth-of-type(1) > code",
                "rect": { … }, "font_size_px": 14, "line_height_px": 22.4 } ],
  "em":     [ … ] | null,
  "strong": [ … ] | null,
  "del":    [ … ] | null,
  "links":  [ { "index": 0, "tag": "a", "text": "link",
                "path": ".doc > p > a", "href": "#x", "rect": { … },
                "font_size_px": 14, "line_height_px": 22.4 } ]
}
```

- `inline.code` **只含行内 `<code>`**：带 `<pre>` 祖先的块级 `code` 已排除。
- `rect` 是元素 `getBoundingClientRect()`（跨行时是并集包围盒）。
- 每个条目 `source` 标注 `rect.* = getBoundingClientRect`、
  `font_size_px / line_height_px = computed style`。

---

## 2.11 `doc.breaks` / `doc.rules`

```jsonc
"breaks": {
  "count": 1,
  "items": [{
    "index": 0, "path": ".doc > p:nth-of-type(2) > br",
    "parent_path": ".doc > p:nth-of-type(2)",
    "rect": { "top": 295.73, "left": 104.30, "right": 104.30,
              "bottom": 311.73, "width": 0, "height": 16 },
    "top_px": 295.73, "left_px": 104.30, "height_px": 16
  }]
},
"rules": {
  "count": 1,
  "items": [{
    "index": 0, "path": ".doc > hr",
    "rect": { "top": 877.31, "left": 20, "right": 620,
              "bottom": 879.31, "width": 600, "height": 2 },
    "height_px": 2, "border_top_width_px": 1, "border_top_style": "inset",
    "margin_top_px": 7, "margin_bottom_px": 7
  }]
}
```

- `<br>` 的 rect 通常是 **0 宽**、行高高度；`width = 0` 是真实测量结果，
  不按「缺元素」处理（元素存在）。
- `<hr>` 高度含 `border-top`（产品是 `border: 0; border-top: 1px`，
  所以产品里通常是 `1`）。

---

## 3. `source` 取值表

| 值 | 含义 |
|---|---|
| `computed style` | `window.getComputedStyle(el)` |
| `getBoundingClientRect` | `el.getBoundingClientRect()`（视口坐标，CSS px） |
| `Range.getClientRects` | `Range.selectNodeContents(el/text).getClientRects()` 的并集 |
| `clientWidth` | `el.clientWidth` |
| `DOM property` | 元素属性（`checked` / `disabled` / `naturalWidth` 等） |

来源显示的用途：区分「浏览器默认值」与「产品样式」。例如表头行高、任务框尺寸
若来自 UA 默认值，`source` 仍是 `getBoundingClientRect`，但设计侧应知道
它不是 `typography.css` 给的。

---

## 4. `diagnostics` 代码表

| `code` | 含义 |
|---|---|
| `doc-missing` | 页面里没有 `.doc`，`doc.found = false` |
| `doc-empty-state` | `.doc` 里挂着 `.doc-empty`（启动页 / 空态），不是正文 |
| `missing-element` | 某一类元素不存在，对应字段为 `null`（`category` 指明是哪一类） |
| `no-line-boxes` | `.doc` 内没有 `width > 0` 的文本 rect |
| `line-height-normal` | `.doc` 的 computed `line-height` 是 `"normal"`，无法给 px |
| `content-width-unavailable` | 无法由 clientWidth / padding 得到 content box 宽 |
| `content-width-nonpositive` | content box 宽 ≤ 0（环境无效） |

---

## 5. 自检

自检用一份**不含 rmd** 的极小 HTML，在 **headless Chrome** 里执行本脚本并断言输出。
自检产物只在 `/tmp`，不入库。

```
# 构建 + 运行（一次性）
node /tmp/parity-selftest/build.js
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-first-run \
  --user-data-dir=/tmp/parity-selftest/chrome-profile \
  --virtual-time-budget=5000 \
  --dump-dom "file:///tmp/parity-selftest/selftest.html" \
  > /tmp/parity-selftest/dump.html
node /tmp/parity-selftest/extract.js
```

夹具含：h1/h2/h3/h6、行内 code/em/strong/del/link、`<br>`、两层列表、
有序列表、引用、含**空行**的代码块、2×2 表格（`display:block; overflow-x:auto`，
与产品一致）、任务项、图片占位、`<hr>`。

**实测结果（2026-11-08，headless Chrome，macOS）**：

| 断言 | 结果 |
|---|---|
| 检查项 | **42 / 42 通过** |
| `line_boxes.count` | **19**（手数：4 标题 + 1 + 2 + 3 + 2 + 1 + 2 + 2 + 2） |
| `line_boxes.by_block_sum` | **21**（表格同一行 2 个单元格各算一行 ⇒ 19 + 2） |
| `zero_width_rects` | 2（代码围栏内的空行等，**未计入**行盒数） |
| `env` | `14px` / `22.4px` / `content_box_width=600`（交叉核对也是 600） |
| 缺失路径 | 无 `h4`/`h5` ⇒ 字段为 `null`，`diagnostics` 恰好两条 `missing-element` |
| 无 `.doc` 页面 | `doc.found=false`，度量字段全 `null`，一条 `doc-missing`（7/7 通过） |

手数对照的原始内容见 `/tmp/parity-findings/domprobe.md`。

---

## 6. 未验证 / 使用注意

1. **只在 Chrome（headless）与几何默认值上实测过**；WKWebView 的
   `Range.getClientRects()` / `getComputedStyle` 行为预期一致，但尚未在真实
   rmd 窗口里跑过（按任务约束，本次不启动 app）。
2. **上标 / 不同字号同行的 top 可能不同**：`<sup>`（脚注引用）等
   `vertical-align` 偏移会让其文本 rect 的 `top` 偏离本行。按 §2.6「按 top 去重」
   的口径，它可能被算成独立行盒。`fixtures-expect.json` 冻结的是脚本实际输出，
   因此同端同环境是自洽的；但**跨环境**（字号/DPR/字体变化）时该处计数可能敏感。
   如首采发现脚注夹具行数异常，应先看 `by_block` 明细再决定是否调整容差
   （`collect({topTolerancePx})`）。
3. **表格同一行的多个单元格**在全局 `count` 里合并成 1 个行盒；这是按 `top`
   去重的直接结果。若本意是「每个单元格一行」，应看 `by_block_sum`，但
   `P-ENV-06` 的相等判定只认 `count`。
4. **`content_box_width_px` 用 `clientWidth`**，是整数（取整）；与
   `content_box_crosscheck_px`（rect 减边框内边距）可能有 <1px 的差。
   §2.8 的 ROI 定法允许 `padding_left = padding_right = 1.5 × font_size` 的
   等价记录；两值同时输出便于核对。
5. **未覆盖**：伪元素生成的列表标记（`::marker`）、mermaid/math 的 SVG 内部
   文本、图片实际像素内容——这些不在本探针的 DOM 文本节点口径内。
