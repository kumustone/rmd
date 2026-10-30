// 主题与阅读设置 —— `design/0004-ui-主题.md` §2.1.3 / §2.1.4 与
// `design/0005-马克飞象默认排版.md` §2.1.5（两份 2026-10-13 已通过）。
//
// # 这个模块的全部难点只有一个：**内存态与磁盘态的关系**
//
// | 层 | 名字 | 是什么 | 谁改它 |
// |---|---|---|---|
// | 内存态 | `applied` | 当前会话真正生效的值 | 用户的每一次切换，**立即** |
// | 内存态 | `dirty` | 是否有未成功落盘的改动 | 保存成功 → 清；失败 → 置 |
// | 磁盘态 | `persisted` | 配置文件里最后**成功写入**的快照 | 保存队列 |
//
// 四条规则（`0004` §2.1.4.1，逐条落到下面的实现里）：
//
//   1. ⭐ **`applied` 永远立即生效，⛔ 不等待磁盘。**
//      用户点了"深色"，界面立刻深色。
//   2. ⭐ **串行单一写者**（`INV-THEME-05`）：主题/字号/行高/内容宽度/侧边栏宽度
//      共用同一个保存队列，合并同键的连续请求，**写的是取当前 `applied` 全量**，
//      ⛔ 不是"发请求那一刻的快照"。
//      ⚠️ 违反的表现极难复现：两个并发写各自带一份旧快照、后者覆盖前者，
//      单独看每次操作都没问题。
//   3. **写失败**：`dirty = true` + 记日志；界面**不弹错**
//      （设置写不进去不值得打断阅读），⛔ 但也不许静默——工具栏上有一行标记。
//   4. **冷启动**：`applied = persisted`（缺失/损坏用默认）。
//
// # ⛔ 存储只有一处（`INV-THEME-03`）
//
// **不用 `localStorage` 缓存主题名**。那会造成第二个存储层，且两者的失效时机不同
// （配置文件被外部改动 / localStorage 被清），最终表现是
// 「设置里显示深色、界面是浅色」这类无法解释的错。
//
// # ⚠️ 与设计的一处文件名差异
//
// `design/0004` §3 写的是 `src/services/theme.ts`，`0005` 写的是 `settings.ts`。
// 这里合并成一个 `.js`：**前端现在是原生 JS，不是 TS**（`adr/0005` 仍是 `proposed`）。
// ⚠️ 两份设计共用**同一个配置层**（0004 §2.1.4.1 规则 2 明写），
//    所以它们本来就该是同一个队列——合成一个文件是这条要求的直接结果，
//    ⛔ 不是"图省事"。

// ⚠️⚠️ **每个文件都包一层 IIFE**——这**不是**风格问题，是必须的。
//
// 经典脚本（⛔ 不是 ES module）的顶层 `const` **共用一个全局词法作用域**：
// 两个文件都写 `const api = …`（或 `const V` / `const S` / `const T`）时，
// 后加载的那个文件**整个不执行**（解析期 `SyntaxError`），
// 而错误只出现在 WebView 的控制台里——本项目看不到它。
//
// 表现：**一个永远开着的空白窗口**，stderr 里连一条错误都没有。
// 2026-10-13 实施 `design/0003` 时真踩到了：7 个模块几乎全被
// `const V` / `const api` 撞掉，冒烟挂在那里一动不动。
//
// ⇒ 双导出（浏览器挂 `window.rmd.*` / node 挂 `module.exports`）**必须在 IIFE 里**。
(function () {
  'use strict';

  /** `design/0004` §2.1.2：三套 + 一档"跟随系统"（§9.1 B3）。 */
  const MODES = ['system', 'light', 'dark', 'warm'];

  /** ⚠️ 这三个是**尺度**（`0005` §2.1.4），⛔ 不是颜色——
      主题切换**不得**碰它们（`INV-THEME-04`）。判据是"在深色下应该不同吗"：否。 */
  const DEFAULTS = {
    fontSize: 14,      // --reader-font-size 的默认（`0005` §2.1.1；⭐ 2026-10-16 由 16 改 14）
    lineHeight: 1.6,   // A1 的结论
    contentWidth: 1200 // A4 的结论：铺满 + 一个宽松上限
  };

  /** ⭐ `design/0014` 裁定 (a)：Vim 模式的**出厂档是关闭**。 */
  const DEFAULT_VIM_MODE = false;

  /**
   * ⭐⭐ **把内存里的记录翻成线上形状**（`docs/bugs/0007`）。
   *
   * ⚠️⚠️ **这两边的键名不一样，而它们必须对上**：
   * 内存记录是 JS 惯用的 camelCase，后端 `config::Appearance` 是 **snake_case**
   * （`font_size` / `line_height` / `content_width` / `vim_mode`）。
   *
   * ⛔ **别把这个函数删掉、也⛔ 别只在内存里改名了事**——
   * 后端**不认识** camelCase 的键，而 serde 对不认识的字段是**默认忽略**
   * （不是报错）⇒ 症状是**一次都不报错的静默数据丢失**：
   * 界面当场生效（乐观更新）、`#save-warn` 也不亮，
   * 只有**关掉再开**才发现"设置全回去了"，而配置文件里那几个键**照样有**
   * （值被 serde 的 `default` 填成了出厂值）。
   * ⚠️ 2026-10-16 实测过一次：`{"mode":"dark","fontSize":20,…}` 反序列化出来
   * `font_size = 14`（＝默认值）。**`theme` 是唯一对得上的键**，所以只有它存得住。
   * ⇒ 那一整轮"外观四件套"里其实**只有主题真的落过盘**。
   */
  function toPayload(snapshot) {
    return {
      mode: snapshot.mode,
      font_size: snapshot.fontSize,
      line_height: snapshot.lineHeight,
      content_width: snapshot.contentWidth,
      vim_mode: snapshot.vimMode === true,
    };
  }

  /** 边界钳制。⚠️ 与 Rust 侧 `config::clamp_*` **必须一致**——
      否则手改配置文件能得到一个前端夹得住、后端夹不住的值。 */
  const FONT_SIZE_MIN = 12;
  const FONT_SIZE_MAX = 28;
  const LINE_HEIGHT_MIN = 1.2;
  const LINE_HEIGHT_MAX = 2.0;
  /** ⚠️ `0` = **铺满（无上限）**，不是"宽度 0"。
      A4 的默认是"铺满 + 1200px 上限"，所以 `0` 是用户显式选了"更宽"之后的值。 */
  const CONTENT_WIDTH_MAX = 2400;
  const CONTENT_WIDTH_MIN = 480;

  function clamp(v, lo, hi, fallback) {
    if (typeof v !== 'number' || !isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  }

  /** `0`（铺满）是合法值，⛔ 不能被"钳到最小宽度"吃掉。 */
  function clampWidth(v) {
    if (typeof v !== 'number' || !isFinite(v) || v === 0) return v === 0 ? 0 : DEFAULTS.contentWidth;
    return Math.min(CONTENT_WIDTH_MAX, Math.max(CONTENT_WIDTH_MIN, v));
  }

  /** 系统现在是深色吗。⚠️ 只在 `mode === 'system'` 时被问到。 */
  function systemPrefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return false;
    }
  }

  /** 把「模式」解析成**真正生效的那套主题**。
      ⚠️ `data-theme` 上写的永远是解析**之后**的值（`light`/`dark`/`warm`），
      ⛔ 不写 `system`——CSS 里没有 `[data-theme="system"]` 这个选择器，
      写了就等于"没有主题"，界面会塌回浏览器默认色。 */
  function resolve(mode) {
    if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
    return MODES.indexOf(mode) >= 0 && mode !== 'system' ? mode : 'light';
  }

  /**
   * 建一个服务。
   *
   * @param {object} opts
   * @param {(applied:object) => Promise<any>} opts.save 真正的写盘（走 `tauri.js`）
   * @param {number} [opts.debounceMs] 合并窗口。⚠️ 见 `INV-THEME-05` 的"防抖"
   */
  function createThemeService(opts) {
    const save = opts.save;
    const debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 150;

    /**
     * ⭐ **订阅者表**（`design/0010` §2.1 ⑤ 的唯一接口变更）。
     *
     * ⚠️ 原来是**一个** `onChange` 回调。`design/0010` 起"能改外观"的表面
     * 从 1 个变成 2 个（顶栏 + 设置覆盖层）⇒ 单回调会让后注册的那个
     * **顶掉**前一个，表现是"在设置里改了主题，顶栏那排控件没跟着变"。
     *
     * ⭐ 返回**退订函数**：覆盖层每次打开/关闭都会重挂控件，
     * 不退订的话监听器会**按打开次数累积**（关掉十次之后改一次主题就重画十一次）。
     */
    const subscribers = [];

    /** ⭐ `applied`：**这一份**就是当前生效的值。
        ⚠️ 初值的 mode 是 `system`（B3 的出厂档），但真正说了算的是
        `reset(快照)` 那一步——它拿的是配置文件里的权威值。 */
    const applied = { mode: 'system', fontSize: DEFAULTS.fontSize,
                      lineHeight: DEFAULTS.lineHeight, contentWidth: DEFAULTS.contentWidth,
                      // ⭐ `design/0014` 裁定 (a)。⚠️ 它**不是外观**（不碰颜色、不碰尺度），
                      //    借着这条记录走只是因为它要**搭同一条写盘队列**——
                      //    独立落盘会造出第二个写者，而 `INV-THEME-05` 要的是单一写者。
                      vimMode: DEFAULT_VIM_MODE };
    /** ⭐ 有没有未成功落盘的改动（`INV-THEME-06`）。 */
    let dirty = false;
    /** 磁盘上最后成功写入的快照（冷启动时用来对照）。 */
    let persisted = null;

    let timer = null;
    let inFlight = false;
    /** 攒着"还有活要干"——写的过程中又改了，写完要再来一次 */
    let again = false;

    // ────────────────────────────────────────────────────────────────
    // 生效（⛔ 不碰磁盘）
    // ────────────────────────────────────────────────────────────────

    /**
     * 把 `applied` 写进 DOM。
     *
     * ⭐ **只改 CSS 自定义属性 + 一个 data 属性**，⛔ 不触碰 DOM 结构、
     *    ⛔ 不触发文档重解析（`INV-THEME-01`）。
     *    违反的话表现是"换主题把阅读进度弄丢了"——滚动位置跳动 /
     *    目录折叠状态丢失 / 搜索高亮错位。
     */
    function apply() {
      const root = document.documentElement;
      root.dataset.theme = resolve(applied.mode);

      // ⚠️ 写到 `documentElement.style` 上的是**同名**变量（`0005` §2.1.5）：
      //    ⛔ 不改 CSS 文件，行内样式天然覆盖 `:root` 里的声明。
      const s = root.style;
      s.setProperty('--reader-font-size', applied.fontSize + 'px');
      s.setProperty('--reader-line-height', String(applied.lineHeight));
      // ⚠️ 铺满 = `none`，⛔ 不是 `0px`——`0px` 会让正文宽度塌成 0。
      s.setProperty('--reader-content-width',
        applied.contentWidth === 0 ? 'none' : applied.contentWidth + 'px');

      // ⭐ **通知放在这里**（`design/0010` §2.1 ⑤）：`apply()` 是"生效值变了"的
      //    唯一汇合点，四条 setter + `reset()` + 跟随系统都经过它。
      //    ⛔ 放在各个 setter 里会漏掉后两条，表现是"跟随系统切了色，设置覆盖层
      //    里那个 select 还停在上一个值"。
      //    ⚠️ 冷启动时 `reset()` 也会走到这儿，那时订阅者表还是空的——无害。
      notify();
    }

    // ────────────────────────────────────────────────────────────────
    // 通知订阅者（`design/0010` §2.1 ⑤）
    // ────────────────────────────────────────────────────────────────

    /**
     * ⚠️ 一个订阅者抛错**不许**拖垮其余订阅者：
     * 设置界面重画失败，不该让顶栏那几个控件也不更新（反之亦然）。
     * ⛔ 但也不吞——`console.error` 会进 stderr（`.agent/spec.md` 纪律 6）。
     */
    function notify() {
      for (let i = 0; i < subscribers.length; i++) {
        try {
          subscribers[i](api);
        } catch (e) {
          console.error('主题订阅者抛错（已忽略，其余订阅者照常）：', e);
        }
      }
    }

    /** 订阅"生效值变了"。⚠️ **返回退订函数**，调用方必须存下来。 */
    function subscribe(fn) {
      if (typeof fn !== 'function') return function () {};
      subscribers.push(fn);
      return function unsubscribe() {
        const i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    }

    // ────────────────────────────────────────────────────────────────
    // 落盘：**串行单一写者**（`INV-THEME-05`）
    // ────────────────────────────────────────────────────────────────

    /** 请求一次保存。连续调用会被合并进同一个窗口。 */
    function scheduleSave() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        flush();
      }, debounceMs);
    }

    /**
     * ⭐ 真正写一次。
     *
     * ⚠️ **写的是 `flush` 那一刻的 `applied` 全量**，⛔ 不是"谁调用了 save"那一刻的快照。
     *    这就是 `INV-THEME-05` 那句话的落地处。
     */
    async function flush() {
      if (inFlight) { again = true; return; }
      inFlight = true;
      // 取一份**当刻**的副本——不是排队时的那一份
      const snapshot = {
        mode: applied.mode,
        fontSize: applied.fontSize,
        lineHeight: applied.lineHeight,
        contentWidth: applied.contentWidth,
        vimMode: applied.vimMode
      };
      try {
        // ⚠️⚠️ **走 `toPayload`**（`docs/bugs/0007`）：直接把这个快照丢给
        //    `set_appearance` 的话，后端只认得出 `mode` 一个键，其余三个**静默取默认值**。
        await save(toPayload(snapshot));
        persisted = snapshot;
        if (dirty) { dirty = false; notify(); }
      } catch (e) {
        // ⚠️ 规则 3：**不弹错**（写不进去不值得打断阅读），⛔ **但也不许静默**。
        dirty = true;
        console.warn('设置没能保存（本次仍然生效，下次启动会回退）：', e);
        notify();
      } finally {
        inFlight = false;
        if (again) { again = false; scheduleSave(); }
      }
    }

    // ────────────────────────────────────────────────────────────────
    // 外部接口
    // ────────────────────────────────────────────────────────────────

    /** 冷启动 / 后端回话之后：把权威值灌进来。⚠️ 这一条**不**触发保存。 */
    function reset(a) {
      const src = a || {};
      // ⚠️ 未知模式回落到 **B3 的出厂档**（`system`），⛔ 不是写死的 `light`：
      //    后端已经夹过一次，这里是第二道——两道不一致时会出现
      //    "后端说 system、前端当 light" 这种只有刷新才看得出来的错。
      applied.mode = MODES.indexOf(src.mode) >= 0 ? src.mode : 'system';
      applied.fontSize = clamp(Number(src.font_size), FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULTS.fontSize);
      applied.lineHeight = clamp(Number(src.line_height), LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULTS.lineHeight);
      applied.contentWidth = clampWidth(Number(src.content_width));
      // ⭐ `design/0014`：只在**显式 `true`** 时才开——⛔ 别写成 `!!src.vim_mode`，
      //    那样后端漏发这个键（或发来一个 `"true"` 字符串）会被读成开启，
      //    而"Vim 模式自己开了"这件事用户第一反应是键盘坏了。
      applied.vimMode = src.vim_mode === true;
      apply();
    }

    function setMode(mode) {
      if (MODES.indexOf(mode) < 0 || mode === applied.mode) return;
      applied.mode = mode;
      apply();            // ⭐ 规则 1：立即生效
      scheduleSave();
    }

    function setFontSize(px) {
      const v = clamp(Number(px), FONT_SIZE_MIN, FONT_SIZE_MAX, applied.fontSize);
      if (v === applied.fontSize) return v;
      applied.fontSize = v;
      apply();
      scheduleSave();
      return v;
    }

    function setLineHeight(n) {
      const v = clamp(Number(n), LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, applied.lineHeight);
      if (v === applied.lineHeight) return v;
      applied.lineHeight = v;
      apply();
      scheduleSave();
      return v;
    }

    function setContentWidth(px) {
      const v = clampWidth(Number(px));
      if (v === applied.contentWidth) return v;
      applied.contentWidth = v;
      apply();
      scheduleSave();
      return v;
    }

    /**
     * ⭐⭐ **开关 Vim 模式**（`design/0014` 裁定 (a)）——全应用**唯一**的写入口。
     *
     * ⚠️ 它在**这里**而不是在编辑面里，是因为这个开关有**两个消费者**：
     *    ① 设置覆盖层里那个复选框（它读 `applied.vimMode` 渲染）；
     *    ② 编辑面（`editor.setVim()`，只在编辑态存在）。
     *    放在编辑面里的话，**没进编辑态时那个复选框就没人管**（点了不选中）。
     *    ⇒ 状态住在这条记录里，编辑面只**订阅**。
     *
     * @returns {boolean} 这次真的改了吗（`false` = 值没变，什么都没做）
     */
    function setVimMode(on) {
      const v = on === true;
      if (v === applied.vimMode) return false;
      applied.vimMode = v;
      // ⚠️ 走 `apply()` 只为**复用那条"生效值变了"的通知汇合点**——
      //    Vim 模式在 CSS 侧**没有落点**（⛔ 它不改 `data-theme`、⛔ 不加 CSS 变量）。
      //    自己直接 `notify()` 也能响，但那样"生效值变了"就有了第二个出口。
      apply();
      scheduleSave();
      return true;
    }

    /**
     * ⭐ 「跟随系统」那一档要能**跟着系统变**。
     *
     * ⚠️ 它只在 `mode === 'system'` 时做任何事；⛔ 用户选了「深色」之后
     *    系统再切浅色也**不许**动他的选择（那正是 B3「用户手动选择优先于系统偏好」）。
     * ⚠️ 这里**不保存**：模式没变，变的是"系统现在是什么"。
     */
    function attachSystemListener() {
      try {
        const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
        if (!mq || !mq.addEventListener) return;
        mq.addEventListener('change', function () {
          if (applied.mode === 'system') { apply(); notify(); }
        });
      } catch (e) { /* 拿不到媒体查询就退化成"启动时解析一次"，⛔ 不抛 */ }
    }

    const api = {
      MODES, DEFAULTS, FONT_SIZE_MIN, FONT_SIZE_MAX, CONTENT_WIDTH_MAX,
      applied, reset, apply, subscribe,
      setMode, setFontSize, setLineHeight, setContentWidth,
      /** ⭐ `design/0014` 裁定 (a)：Vim 模式的唯一写入口。 */
      setVimMode,
      attachSystemListener,
      resolve, clamp, clampWidth, systemPrefersDark,
      /** ⚠️ 测试用：内存记录 ⇒ **线上形状**那一跳（`docs/bugs/0007`）。产品代码里⛔ 不要绕过 `flush` 调它。 */
      toPayload,
      isDirty: function () { return dirty; },
      persistedSnapshot: function () { return persisted; },
      /** ⚠️ 测试用：把队列排空。产品代码里⛔ 不要调——那会绕过防抖。 */
      _flushNow: flush,
    };
    return api;
  }

  const api = { createThemeService, MODES, DEFAULTS, resolve, clamp, clampWidth, toPayload,
                DEFAULT_VIM_MODE,
                FONT_SIZE_MIN, FONT_SIZE_MAX, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX,
                CONTENT_WIDTH_MIN, CONTENT_WIDTH_MAX, systemPrefersDark };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).theme = api;
})();
