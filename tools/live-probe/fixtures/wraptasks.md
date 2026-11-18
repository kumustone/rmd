# 长任务项：折行与续行（`bugs/0302`）

这一份夹具专供"任务项内容超过一行"的排版判据。四种形态：

1. **长中文**：靠正常断行折成两行以上，续行应当与正文左缘对齐（⛔ 不是回到方框下面）。
2. **长单词**：一整串没有空格的字符。首行应当在方框后面**继续排字**，⛔ 不是整段掉到第二行。
3. **源码续行**：任务的第二行是源码里的另一行，回车之后要继承任务项。
4. **松散项**（文末脚注里）：正文包在 `<p>` 里，方框必须落在**首段内部**，⛔ 不是独占首行。

- [ ] 这是一条很长的中文任务项，用来检查软换行之后第二行是不是仍然与正文左缘对齐：这里继续写很多很多字符，凑够两行以上，然后再写一些，确保一定超过窗口宽度。
- [ ] dfdfasdfasdfasdfdadddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
- [ ] 源码续行的任务项
  这是源码里的第二行，行尾回车之后应该继承任务项（`bugs/0300` 现象二）。
- [ ] 验收：`make test` + `make test-js`；改编辑/命令面另跑 `cargo test --release --features gui`；改样式跑 `make lint-theme`；真实 IME 只能人工
  改样式跑 `make lint-theme`；真实 IME 只能人工

⚠️ 下面这张表只是脚注引用的落脚点：`Table` 不可编辑，却仍解析行内语法。脚注定义只有被引用才物化，所以需要一处引用；`0303` 的判据落在文末那段脚注定义上，理由见 `docs/bugs/0303` §5。

本夹具在脚注定义里写下 `Q 段不适用`：`block-harness.js::跑单元格` 见到它就记 `摘要.Q = {适用:false}`（与"这份没有表格"同一档，⛔ 不是记通过）——这张 2×2 残表本来就不该被 `Q26`–`Q34` 那族"末格右侧死区"的判据挑中；表格能力面由 `blocks.md`／`tasks.md` 覆盖。

| 脚注引用放在这里 | 为什么 ⛔ 不放在上面的列表里 |
|---|---|
| 松散任务列表[^loose] | 见上：`Table` 是 `editable=0` 又解析行内语法的唯一落脚点 |

[^loose]: 脚注定义里的**松散**任务列表（⛔ 不是可编辑块 ⇒ 不进 B 段的等高对照；
    也⛔ 不与 `bugs/0112` B5「编辑态松散列表缺段距」混在一起）。它走 `<li><p>` 那条渲染路，
    用于验证方框落在首段**内部**、首行不只剩一个方框（Q 段不适用：上面那张表只用来物化本条）。
    这一段还故意带一处引用[^inner]：`S1`（`bugs/0303`）要的就是**多视觉行**里上标所在行的行距。

    - [ ] dfdfasdfasdfasdfdaddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd

    - [ ] 松散任务项的短文本

[^inner]: 只用来在**不可编辑**的脚注定义里物化一处引用（`bugs/0303` 的 `S1` 夹具）。
    ⛔ 别把它挪进正文：编辑态会把 `[^inner]` 显示成 `^inner`（Lezer 无 Footnote 扩展，`docs/kb/0032`）。
