// `design/0012` §2.5 的单测：**打进产物的那个 bundle**（`src/vendor/cm6.bundle.js`）。
//
// ⭐ 为什么值得单测一份**产物**：`§2.5-2` 的三件事**全都不报错**，只会静默地出问题——
//
//   ① **形态**：它必须是**经典 script**（IIFE、一个全局名）。
//      哪天有人把入口改回 `type="module"`，`<script src>` 那一句在 WKWebView 里
//      就**整份不执行**（没有 `module` 属性时浏览器拒绝 `import` 语法），
//      而 `index.html` 看起来完全正常、其他脚本也照跑 ⇒ 只有点了「编辑」才发现是空的。
//   ② **导出面**：§2.1① 那张扩展白名单是**白名单**——多一项就是改本设计。
//      而"多一项"在产物里**看不出来**（多一个导出的名字，页面照样工作）。
//   ③ ⭐ **`\r` 活不下来**：这是 §2.4-5 整段（信封）**唯一**的事实依据。
//      它住在一份第三方 dist 里（`@codemirror/state` 的 `DefaultSplit`），
//      ⇒ 哪天升级版本改了这条，本设计的**全部推理基础**就没了，
//      而表现是"保存之后 CRLF 文件变成混合行尾"——**几周后才有人发现**。
//
// 跑法：`make test-js`（= `node --test tests/js/`）。
// ⚠️ bundle 不在时**直接失败**（⛔ 不是 skip）：没有它，编辑面根本不存在，
//    "跳过"会让 `make test` 在这一整块上变成绿的。跑 `make cm6` 就有了。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BUNDLE = path.join(__dirname, '..', '..', 'src', 'vendor', 'cm6.bundle.js');

/** 把 bundle 当**经典 script** 执行，返回它所在的那个全局作用域。 */
function run() {
  assert.ok(
    fs.existsSync(BUNDLE),
    `⛔ 没有 ${path.relative(path.join(__dirname, '..', '..'), BUNDLE)} —— 跑 \`make cm6\`（要 node）`
  );
  const g = {};
  vm.createContext(g);
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), g);
  return g;
}

/**
 * ⚠️⚠️ **跨 realm 的数组必须过这一道**——本文件踩过，且报错信息极具误导性：
 *
 * bundle 跑在 `vm` 自己的 context 里 ⇒ 它造出来的数组，原型是**那个 realm 的**
 * `Array.prototype`。而 `assert.deepStrictEqual` 是**连原型一起比**的
 * ⇒ `deepStrictEqual([], [])` **会失败**，且 diff 打出来是 `actual: [] / expected: []`，
 * 看上去像"断言写错了"，其实是原型不同。
 *
 * ⇒ 凡是拿 bundle 里的数组（`historyKeymap` / `Object.keys` 的结果）来断言的，
 * 先 `Array.from` 换成本 realm 的数组。
 */
const 取过来 = (arr) => Array.from(arr);


/**
 * §2.1① 的扩展白名单 ⇒ 入口**只许**导出这些（逐条对得上）。
 *
 * ⭐ **8 → 11（`design/0014`，2026-10-16）**：加了 `Compartment` / `vim` / `Vim`。
 * ⚠️ 加这一批的**代价**在那份设计里写着（§1.5）：§2.1① 这张表对**编辑面**不再封闭
 * （`vim()` 一次带进 `ViewPlugin` / `Decoration` / 隐藏原生插入符 / 面板四件）。
 * ⛔ 但**对本入口来说它仍是一张白名单**：逐条仍要对得上，多一项仍是改设计。
 *
 * ⭐⭐ **2026-10-27：`design/0052` / `adr/0013` 把这张表**劈成两栏** ——
 *    「加一项 = 改设计」这条摩擦**只留给 B 栏**（呈现与输入面）；
 *    A 栏（文档语义面：事务/选区/历史/语法树/**不绑键位**的命令）加一项只改入口注释。
 *    ⚠️ **这张"恰好相等"的判据一个字没松** —— 它仍然是"多一项就红"，
 *    变的只是"多的那一项算不算设计变更"。两栏的归属由 `keymap.test.js` 的
 *    **两栏闸门**逐符号比对（那一份读 `docs/design/0052` §2.1 的 B 栏清单）。
 */
const 白名单 = [
  // ── A · 文档语义面（入口注释里逐项写了用途；加一项只改注释）────────────────
  'EditorState', // EditorState.create / Text（缓冲往返）
  'Compartment', // ⭐ design/0014 裁定 (a)：Vim 开关靠 reconfigure 换扩展，⛔ 不用 setState（会重建 EditorState ⇒ 丢撤销历史）
  'StateField', // 块级装饰必须走它（`ViewPlugin` 一抛 `RangeError` 就整块白屏）
  'Decoration', // 零宽替换：藏 Markdown 标记，⛔ 不删字符
  'WidgetType', // 替换后落点的类型（`Decoration.replace({})` 的搭档）
  'EditorSelection', // ⭐ 0052 U1：选区语义。`bugs/0014` 的 `range()` 形状就在这一族
  'history', // ⭐ 0052 U2：撤销/重做的**唯一**真值
  'undo',
  'redo',
  'undoDepth',
  'redoDepth',
  'isolateHistory', // U2 的粒度控制：`begin()`/`leave()` 处打断历史分组
  'deleteCharBackward', // ⭐ 0052 U2：删除语义不再由本仓手写（`bugs/0014` 的成因）
  'deleteCharForward',
  'deleteGroupBackward',
  'insertNewline',
  'insertBlankLine',
  'selectAll',
  'syntaxTree', // ⭐ 0052 U3：标记识别不再由逐行正则扫描（`bugs/0015`/`0016`）
  'ensureSyntaxTree',
  'syntaxTreeAvailable',
  'markdown',
  'markdownLanguage', // ⭐ 0052 U3：`markdown()` 的**带 GFM 方言**的 base。不换 base ⇒ `~~删~~` 不是 `Strikethrough` ⇒ 标记藏不掉
  'insertNewlineContinueMarkup', // 列表续行（⛔ 不装 `markdownKeymap`，由 rmd 决定绑哪个键）
  'deleteMarkupBackward',
  // ── B · 呈现与输入面（⛔ 仍然封闭：加一项必须改 `design/0052` §2.1 的表）────────
  'Prec', // §2.3-4：转发用 Prec.low。⚠️ 「Vim 插槽留 Prec.higher」那句**已作废**：Prec 没有 higher，而且 vimPlugin 不在 keymap facet 里（design/0014 §1.1 更正块）
  'EditorView', // 含静态成员 lineWrapping / updateListener
  'keymap',
  'lineNumbers',
  'historyKeymap',
  'vim', // ⭐ design/0014：安装扩展（build() 原样返回它那 4 项，INV-VIM-01）
  'Vim', // ⭐ design/0014：运行期 API（defineEx 接 :w / mapCommand 接 ⌃K ⌃H）
];

/** ⛔ §2.1① 明写"不装"的那几样（含"等于把一整串装回来"的 basicSetup）。 */
const 禁项 = [
  'defaultKeymap',
  'standardKeymap',
  'emacsStyleKeymap',
  'basicSetup',
  'drawSelection',
  'markdownKeymap',
  'highlightActiveLine',
  'closeBrackets',
  'bracketMatching',
  'foldGutter',
];

test('bundle 是经典 script：一个全局名，⛔ 不多挂', () => {
  const g = run();
  const 新挂的 = Object.keys(g).filter((k) => !['global', 'globalThis'].includes(k));
  assert.deepStrictEqual(
    新挂的,
    ['rmdCM6'],
    `⛔ 顶层挂了 ${新挂的.join(' / ')}——§2.5-2 只许有一个全局名（rmdCM6）。` +
      '多出来的名字会与页面里别的脚本抢同一个作用域'
  );
  assert.strictEqual(typeof g.rmdCM6, 'object');
});

test('bundle 源码里没有顶层 import/export（就是上面那条的因）', () => {
  const src = fs.readFileSync(BUNDLE, 'utf8');
  const 顶层 = src
    .split('\n')
    .filter((l) => /^\s*(import|export)\s/.test(l));
  assert.deepStrictEqual(顶层, [], `⛔ bundle 里有顶层 import/export：${顶层.join(' | ')}`);
  // ⚠️ 正面判据：它得是 `var rmdCM6 = (() => {…})()` 那个形态
  assert.match(src, /^var rmdCM6 = \(\(\) => \{/, 'bundle 的开头不是 IIFE 形态');
});

test('导出面**恰好**是白名单里的每一项（多一项就是改设计）', () => {
  const g = run();
  assert.deepStrictEqual(Object.keys(g.rmdCM6).sort(), [...白名单].sort());
});

test('白名单里没有禁项（§2.1① 的"明确不装"）', () => {
  const g = run();
  const 混进来的 = 禁项.filter((b) => b in g.rmdCM6);
  assert.deepStrictEqual(混进来的, [], `⛔ 导出面里混进了禁项：${混进来的.join(' / ')}`);
});

test('每个导出的东西都是可用的类型（⛔ 不是 undefined）', () => {
  const g = run();
  for (const k of 白名单) {
    assert.ok(
      g.rmdCM6[k] !== undefined && g.rmdCM6[k] !== null,
      `${k} 是空的 —— 入口 export 了但没真的带出来`
    );
  }
  // ⛔ 这一条针对"某个包被 tree-shake 掉/版本不对"：类型得对上
  assert.strictEqual(typeof g.rmdCM6.EditorState.create, 'function');
  assert.strictEqual(typeof g.rmdCM6.EditorView, 'function');
  assert.strictEqual(typeof g.rmdCM6.markdown, 'function');
  assert.strictEqual(typeof g.rmdCM6.history, 'function');
  assert.ok(Array.isArray(g.rmdCM6.historyKeymap), 'historyKeymap 应当是键位数组');
});

/**
 * ⭐⭐ `design/0014` 那三项的**可用性**判据（2026-10-16 新增）。
 *
 * ⚠️ 为什么值得单独一条：这三项**全都不能靠"名字在不在"判断**——
 * `vim` / `Vim` 从 `@replit/codemirror-vim` 来，它带着自己整棵依赖树；
 * 升级、tree-shake、或哪天有人把 `export` 写成 `export default` 的形态，
 * 表现都是**运行期才炸**，而炸点是编辑态（`:w` 静默不写盘 / 开关切不动）。
 * ⇒ 这里钉的是**三个真会被调到的成员**，⛔ 不是"名字存在"。
 */
test('design/0014 的三项：`vim()` / `Vim` 的方法面 / `Compartment` 都真的能用', () => {
  const g = run();
  const { vim, Vim, Compartment } = g.rmdCM6;

  assert.strictEqual(typeof vim, 'function', 'vim 应当是函数（build() 要调它）');
  // ⚠️ `vim()` 需要 options.status 才带面板；这里**不真装**（没有 EditorView），
  //    只钉"它是可调用的、且返回的是扩展（数组）"。
  const 四件 = vim({ status: true });
  assert.ok(Array.isArray(四件), 'vim() 应当返回一个扩展数组（§1.3 ①：恰好 4 项）');
  assert.strictEqual(四件.length, 4, 'vim() 返回的项数变了 —— design/0014 §1.3 ① 那张表要重读');

  // ⭐ `:w` 走 defineEx、`⌃K`/`⌃H` 走 mapCommand ⇒ 两个都必须是函数
  assert.strictEqual(typeof Vim.defineEx, 'function', 'Vim.defineEx 不在 —— `:w` 会静默无效');
  assert.strictEqual(typeof Vim.mapCommand, 'function', 'Vim.mapCommand 不在 —— 裁定 (e) 的落法没了');
  // ⚠️ `defineAction` 本设计**不用**，但它与 defineEx 同属注册面：
  //    上游把这两个挪走/改名，说明 API 面动过 ⇒ 值得在这里响亮一次（§7.2 点名要它）。
  assert.strictEqual(typeof Vim.defineAction, 'function');

  // ⭐ `Compartment`：裁定 (a) 的切换**只能**走 reconfigure ⇒ 这个成员不在就等于不能切换
  assert.strictEqual(typeof Compartment, 'function');
  const c = new Compartment();
  assert.strictEqual(typeof c.of, 'function', 'Compartment.of 不在 —— 装不上 vimExt');
  assert.strictEqual(typeof c.reconfigure, 'function', 'Compartment.reconfigure 不在 —— 裁定 (a) 的切换没了');
  // ⛔ 反面：**没有** `setState` 这种东西（`Compartment` 的存在意义就是"不重建 state"）
  assert.strictEqual(c.setState, undefined, '⛔ Compartment 上冒出了 setState —— 那不是它该有的面');
});

/**
 * ⭐ §2.1① 那条「⚠️ 逐条 mac 变体**以锁定的 `@codemirror/commands@6.11.1` 源码为准**，
 * 实施时核一遍」就是下面这两条 —— 已核，并把**实测形态**钉在这里：
 *
 * `historyKeymap` 共 **5** 条（`@codemirror/commands@6.11.1` 打出来的形态）：
 *
 * | 条目 | 键 | mac 变体 |
 * |---|---|---|
 * | undo | `Mod-z` | — |
 * | redo | `Mod-y` | **`Mod-Shift-z`** |
 * | redo（linux） | `linux: Ctrl-Shift-z` | ⛔ 非 mac，不参与 |
 * | undo selection | `Mod-u` | — |
 * | redo selection | `Alt-u` | **`Mod-Shift-u`** |
 *
 * ⚠️ 与 §2.1① 原文的差别只有一处：它没提那条 **linux-only** 的 `Ctrl-Shift-z`。
 * ⇒ 结论不变（macOS 上它压根不生效），但**判据要写对**：
 * "没有 Ctrl 单键"指的是 **`Ctrl-<一个字母>`**，而 `Ctrl-Shift-z` 是**两键**组合、
 * 且只在 linux 分支上 ⇒ 它**不是**决策 3 要预留的那种 Ctrl 单键。
 * ⛔ 把判据写成 `^Ctrl-` 会把这条误报成违规（本文件的第一版就是这么写的）。
 */
test('historyKeymap 在 macOS 上没有 Ctrl 单键（决策 3 的 Ctrl 预留不受影响）', () => {
  const g = run();
  const mac相关 = 取过来(
    g.rmdCM6.historyKeymap.flatMap((b) => [b.key, b.mac]).filter((x) => typeof x === 'string')
  );

  const ctrl单键 = mac相关.filter((k) => /^Ctrl-[A-Za-z]$/.test(k));
  assert.deepStrictEqual(ctrl单键, [], `⛔ mac 路径上有 Ctrl 单键：${ctrl单键.join(' / ')}`);

  // ⚠️ 更强的一条：mac 路径上**完全不许**出现 `Ctrl-`（含两键组合）。
  //    它成立的理由是"linux 变体单独放在 `linux:` 字段里"⇒ 顺手把"实现方式变了、
  //    mac 变体被挪进 `key`"这种改动也一起挡住。
  const ctrl任何 = mac相关.filter((k) => /^Ctrl-/.test(k));
  assert.deepStrictEqual(ctrl任何, [], `⛔ mac 路径上出现了 Ctrl 组合：${ctrl任何.join(' / ')}`);

  // ⭐ 钉住"整份装得下"的**边界**：5 条、且探到的那两条 mac 变体确实在。
  assert.strictEqual(g.rmdCM6.historyKeymap.length, 5, 'historyKeymap 的条数变了 —— §2.1① 那张表要重读');
  assert.ok(mac相关.includes('Mod-Shift-z'), '少了 redo 的 mac 变体 Mod-Shift-z');
  assert.ok(mac相关.includes('Mod-Shift-u'), '少了 redo-selection 的 mac 变体 Mod-Shift-u');
});

/**
 * ⭐ **与应用键表不许撞车**（§2.3-4 那条推导的**前提**）。
 *
 * ⚠️ 撞车的表现是最难查的一种：转发白名单里**有**这一项（`owner=web ∧ 含 cmd`），
 * 但 CM6 的 `historyKeymap` 在**默认优先级**上先吃掉了它 ⇒ 编辑区里那个键
 * **静默地**不执行应用动作。⇒ 这里把"不撞"变成一条判据。
 *
 * ⚠️ 判据的口径：`Cmd` / `Mod` 在 macOS 上**是同一个键** ⇒ 两边都当 `Mod-` 比。
 */
test('historyKeymap 不吃掉任何应用快捷键（macOS 口径）', () => {
  const g = run();
  // ⚠️ 手抄自 `src-tauri/src/gui/mod.rs` 的 `SHORTCUTS`（那张表是 Rust 侧的**唯一**定义，
  //    JS 侧拿不到 ⇒ 这是本文件里**唯一**一处抄写，改表时这里要跟着改）。
  const 应用 = [
    'Cmd+,',
    'Cmd+B',
    'Cmd+O',
    'Shift+Cmd+O',
    'Cmd+=',
    'Cmd+-',
    'Cmd+0',
    'Cmd+S',
    'Cmd+E',
    'Shift+Cmd+E',
    'Cmd+P',
    'Cmd+R',
    'Cmd+F',
    'Cmd+G',
    'Shift+Cmd+G',
  ];
  const 归一 = (s) =>
    s
      .split('+')
      .map((x) => (x === 'Cmd' ? 'Mod' : x))
      .sort()
      .join('+');
  const 应用集 = new Set(应用.map(归一));

  const cm6 = 取过来(
    g.rmdCM6.historyKeymap
      .flatMap((b) => [b.key, b.mac])
      .filter((x) => typeof x === 'string')
  ).map(归一);

  const 撞了 = cm6.filter((k) => 应用集.has(k));
  assert.deepStrictEqual(
    撞了,
    [],
    `⛔ CM6 的 historyKeymap 与应用快捷键撞了：${撞了.join(' / ')} —— ` +
      '编辑区里那个键会静默地不执行应用动作（§2.3-4）'
  );
});


test('⭐ `\\r` 活不下来：这是 §2.4-5 信封整段的事实依据', () => {
  const g = run();
  const { EditorState } = g.rmdCM6;

  // ① `\r\n` ⇒ `\n`
  const crlf = EditorState.create({ doc: 'a\r\nb\r\n' });
  assert.strictEqual(crlf.doc.toString(), 'a\nb\n', '⛔ `\\r\\n` 居然活下来了 —— 信封那套推理要重读');
  // ② **裸 `\r`** 也是换行（`DefaultSplit = /\r\n?|\n/` 里的 `\r\n?`）
  const cr = EditorState.create({ doc: 'a\rb' });
  assert.strictEqual(cr.doc.toString(), 'a\nb', '⛔ 裸 `\\r` 没被当换行');
  // ③ 行数也是按它们算的（⚠️ 与 ② 是同一条规则的另一面）
  assert.strictEqual(EditorState.create({ doc: 'a\r\nb\nc' }).doc.lines, 3);
  // ④ ⛔ 反面：`\r` **不可能**通过"造一个带 `\r` 的 state"混进缓冲
  assert.ok(
    !EditorState.create({ doc: 'x\ry' }).doc.toString().includes('\r'),
    '⛔ 缓冲里出现了 `\\r` —— 那 §2.4-5 的"恒 LF"前提不成立'
  );
});
