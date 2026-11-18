# 嵌套围栏的超宽代码行（`design/0085` C7 离屏实测）

这一份只给 `design/0085` §9.6 的 C7 判据用：**列表项里的围栏代码**中有一行远宽于内容列
（阅读态 `pre` 默认不换行、靠 `overflow-x` 横滚；编辑态是 CM6 的 `lineWrapping`）。
⚠️ 它测的是"乙类是否必须换结构"，⛔ 不是阅读排版判据的唯一来源，也⛔ 不替代其它夹具。

这是普通段落，用来量"块外零位移"。

- 列表项里放一段远宽于内容列的代码：

  ```js
  const 超宽 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  ```

- 列表末项，用来确认后面的内容照常排。

后面还有一段，用来量"块外零位移"的另一侧。
