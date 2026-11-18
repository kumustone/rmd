// @ts-check —— `design/0052` U8：本文件在 `make typecheck`（`tsconfig.check.json`）的检查范围里。
// ⚠️ 本文件仍是**经典脚本**（`frontend.md` 第 1、2 条）：这里只加类型注解，⛔ 不改运行时形状。
// R1 输入子系统：**事件 → 事务**的状态机 —— `design/0047` §2.7 / `INV-LIVE-12` / `INV-LIVE-17`。
//
// 形态（§2.7）：`contentDOM` 永不被聚焦（`contenteditable=false` ＋ `tabindex=-1`），
// 输入事件来自一个**离屏 `textarea`**。本文件只回答"这串事件该产出几条事务、
// 每条事务改哪一段"，⛔ 不碰 DOM、⛔ 不调 CM6、⛔ 不碰剪贴板 API（那是接线层的事）。
//
// ## 四条硬规则（每条都对应一个**用户能看见**的坏形态）
//
// 1. ⭐ **组合期间文档的文本一个字节都不动**（用户 2026-10-26 的强需求 `F6`）：
//    `compositionupdate` 只更新**临时态**（交给装饰层画 preedit），⛔ 不产出**文本**事务。
//    ⚠️ `design/0059` C′ 校正（2026-11-03 最终评审 P1-5）：**装饰事务、占位符与正常重排照常发生**
//    ——组合串参与排版、把右边的字推开是**允许且要的**；⛔ 别再把它读成"零事务/版面不动"。
//    禁的只有一件事：把暂存输入写进 `state.doc` / 磁盘。
// 2. **组合结束只落一条文本事务**，⛔ 不是"逐键落"。
// 3. ⭐ **组合结束后的那一发重复 insert 必须被吃掉**（WebKit 会在 `compositionend`
//    之后补发一次 `beforeinput`/`input`，`isComposing` 为假、`data` 与组合结果相同）
//    ⇒ 不然同一个词会被**插两遍**。
//    ⚠️ 判据是 **"类型是 insert ∧ data 与刚提交的文本逐字相同"**，⛔ 不是一个无条件的
//    "吞下一发"开关——后者在浏览器**没有**补发时会把用户真正敲的那个字符吃掉。
// 4. ⭐ **`\r` 永远不许进 `fullText`**（全文模型恒 LF，`INV-LIVE-13`）。
//    唯一现实入口是粘贴：从终端/别的编辑器复制一段 CRLF 文本。不规范化的话
//    它留在行里——不换行、不可见，却**让行号与预期错位**，而且下次 `Envelope::detect`
//    会算出 `Eol::Other` ⇒ **整篇变不可编辑**（`blocks.rs::to_wire` 那道闸）。
// 5. ⭐ **组合会话是显式的、绑定到目标文本的**（`design/0059` C′，最终评审 P1-5）：
//    起手时记下 `{from, to, target, revision}`；落定时拿**当前**目标与修订对一次。
//    目标文本已经变过（期间有别的提交 / 替换选区 / 外部重载）⇒ ⛔ 不许往旧区间里写，
//    按**当前**选区重新落定并在结果里标记 `rebased`；同一个 `target` 都没有了 ⇒ 丢弃并说出来。
//    取消 / 粘贴去重 / 过期回包各有自己的分支，⛔ 不共用一个"待吞开关"。
//
// ⚠️ 语义与 `tools/live-probe/js/inputState.js` 一致（那是步骤 0 的可运行证据）；
// 本文件多两件事：`beforeinput` 的 `inputType` 分派、以及上面第 3 条**改成按内容判**。
//
// ⚠️⚠️ **每个文件都包一层 IIFE**——经典脚本共享全局词法作用域，
// 顶层 `const` 撞名会让**整个文件不执行**（窗口空白、stderr 全静默）。
// 理由与实测见 `services/chunked.js` 文件头。

(function () {
  'use strict';

  /**
   * ⭐ **`\r` 永远不许进 `fullText`**：CRLF / 裸 CR 一律归一成 LF。
   * ⚠️ 只做这一件事，⛔ 不做别的规范化（不 `trim`、不折叠空白）——
   * 多余的处理会让"提交上去的文本 ≠ 用户看到的东西"。
   */
  function normalizeNewlines(text) {
    return String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
  }

  /** 一段输入文本 → 行数组（已归一化行尾）。 */
  function linesOf(text) {
    return normalizeNewlines(text).split('\n');
  }

  /**
   * 事件是不是**组合态**的。
   *
   * ⚠️ 自己的标志位优先：`compositionstart` 之后、`compositionend` 之前的任何事件都算组合态，
   * ⛔ 不依赖 `ev.isComposing`（Safari 某些版本在 `input` 上不给这个字段）。
   */
  function isComposingEvent(ev, state) {
    return state.composing || ev.isComposing === true;
  }

  /** 这个 `inputType` 是"插入"类。 */
  function isInsertType(t) {
    return typeof t === 'string' && t.slice(0, 6) === 'insert';
  }

  /** 这个 `inputType` 是"删除"类。 */
  function isDeleteType(t) {
    return typeof t === 'string' && t.slice(0, 6) === 'delete';
  }

  /**
   * @param {(tx:{from:number,to:number,next:string[],reason:string}) => void} onTransaction
   *   ⚠️ `from`/`to` 是 **0-based 半开区间**，与 `live/blocks.js` 的 `from`/`to` 同一口径。
   * @param {{text?:function(string):string}} [policy] 编辑对象给的**输入约束**
   *   （`design/0054` `INV-EDITOBJ-01`，策略表在 `live/objects.js`）。
   *   ⚠️ 它作用于**每一个文本入口**（`beforeinput` 插入 / `input` / `paste` /
   *   `compositionend`）——⛔ 不是只在粘贴上折一次：只折一个入口的形态是
   *   "改粘贴管住了、IME 上屏那条路照样把换行塞进去"。缺省 = 不约束。
   */
  function createInputMachine(onTransaction, policy) {
    /**
     * ⭐ **唯一的入口约束点**：先归一化行尾（`INV-LIVE-13`），再按对象策略处理。
     * ⚠️ 顺序不能反——见 `live/objects.js::foldNewlines` 的注释（CRLF 会剩下裸 `\r`）。
     * @param {string|undefined|null} raw
     * @returns {string}
     */
    function textIn(raw) {
      const norm = normalizeNewlines(raw);
      const rule = policy && typeof policy.text === 'function' ? policy.text : null;
      return rule ? String(rule(norm)) : norm;
    }

    const state = {
      composing: false,
      start: 0,
      end: 0,
      provisional: '',
      /**
       * ⭐ **组合会话**（`design/0059` C′）：`null` = 不在组合态。
       * `{from, to, target, revision}` 里 `target` / `revision` 是**不透明令牌**
       * （接线层传视图的文本身份 / 文档修订键），本文件只做相等比较，⛔ 不解释它们。
       * ⚠️ 它回答的是"这一串暂存输入属于哪一份目标文本"；没有它，落定就只能信
       *    `compositionstart` 那一刻的偏移——期间有过别的提交就会写进错的位置。
       */
      session: null,
      /** 刚由 `compositionend` 提交的文本（`null` = 没有待吞的那一发）。 */
      swallow: null,
      /**
       * ⭐ 组合期间粘贴进来的文本，**等组合结束再补一条**。
       *
       * ⚠️ 为什么不并进 `provisional`：`provisional` 是 preedit 的镜像，
       * 而 `compositionend` 提交的是**它自己的 `data`**——并进去就等于**静默丢掉**用户粘贴的内容。
       * ⛔ 那正是本项目最不能接受的一类错（吞内容）。
       * ⇒ 顺序写死：**先上屏组合结果，再插粘贴内容**，两条事务（两个不同的用户动作）。
       */
      pending: [],
    };

    function tx(from, to, next, reason) {
      onTransaction({ from: from, to: to, next: next, reason: reason });
    }

    /**
     * ⭐ 组合的落定目标：**当前的**目标优先，没有才退回起手那一份。
     *
     * `rebased` 说的是"起手记下的那份目标已经不是现在这份了"——期间有过别的提交、
     * 替换选区或重载。此时⛔ 不许拿旧偏移去写（那会落到别的字中间），
     * 按接线层给的**当前**选区落定；连目标都没有了（`lost`）⇒ 调用方丢弃并说出来。
     *
     * @param {object} e
     * @param {{from:number, to:number, target:any, revision:any}|null} s
     */
    function settleTarget(e, s) {
      const at = s || { from: 0, to: 0, target: null, revision: null };
      const hasNow = typeof e.from === 'number' && typeof e.to === 'number';
      const nowTarget = e.target === undefined ? null : e.target;
      const nowRev = e.revision === undefined ? null : e.revision;
      const targetChanged = at.target !== null && nowTarget !== null && at.target !== nowTarget;
      const revChanged = at.revision !== null && nowRev !== null
        && String(at.revision) !== String(nowRev);
      return {
        from: hasNow ? e.from : at.from,
        to: hasNow ? e.to : at.to,
        rebased: hasNow && (targetChanged || revChanged
          || e.from !== at.from || e.to !== at.to),
        lost: !hasNow && targetChanged,
      };
    }

    /**
     * 这是不是"组合结束后的那一发重复 insert"。
     * ⚠️ 只有**内容逐字相同**才吞，且吞完就清掉——⛔ 不吞第二发。
     */
    function trySwallow(ev, text) {
      if (state.swallow === null) return false;
      if (text !== state.swallow) {
        // 内容不同 ⇒ 那是用户真的敲了别的字，⛔ 不许吞；同时这一发也不是重复发。
        state.swallow = null;
        return false;
      }
      state.swallow = null;
      return true;
    }

    return {
      /** 只读快照（测试与状态条用）。 */
      get state() {
        return {
          composing: state.composing,
          start: state.start,
          end: state.end,
          provisional: state.provisional,
          /** ⭐ 显式组合会话（`design/0059` C′）；`null` = 不在组合态。 */
          session: state.session ? {
            from: state.session.from,
            to: state.session.to,
            target: state.session.target,
            revision: state.session.revision,
          } : null,
          swallow: state.swallow,
          pending: state.pending.slice(),
        };
      },

      /**
       * 处理一个**已经归一化过**的事件对象。
       *
       * 归一化（`compositionend` 的 `data`、`beforeinput` 的 `data`、
       * `paste` 的剪贴板文本）由接线层做，⛔ 不在状态机里摸 DOM。
       * @returns {{applied:boolean, why:string, stale?:boolean, rebased?:boolean}}
       */
      handle(ev) {
        const e = ev || {};
        switch (e.type) {
          case 'compositionstart': {
            state.composing = true;
            state.start = e.from;
            state.end = e.to;
            state.provisional = '';
            state.swallow = null;
            state.session = {
              from: e.from,
              to: e.to,
              target: e.target === undefined ? null : e.target,
              revision: e.revision === undefined ? null : e.revision,
            };
            return { applied: false, why: '组合开始：不动文档文本（装饰与重排照常）' };
          }

          case 'compositionupdate': {
            if (!state.composing) return { applied: false, why: '不在组合态，忽略' };
            state.provisional = e.data || '';
            // ⭐ 只更新临时态 ⇒ ⛔ 不写文档文本；组合串由 preedit/装饰参与排版。
            //    组合期的重排由 `INV-LIVE-04`（**2026-11-09 版**）② 管：位移只能来自
            //    **真实文本变化**，组合串算真实输入（`design/0059` C′ 那句"允许正常重排"
            //    按此读；⛔ 它**不放松**进入那一瞬间的逐像素不动）。
            return { applied: false, why: '组合中：只更新临时态' };
          }

          case 'compositionend': {
            if (!state.composing) return { applied: false, why: '不在组合态，忽略' };
            // ⚠️ 组合结果同样过对象约束：IME 也能把换行带回来（删词/换行候选），
            //    ⛔ "只折粘贴"的形态在这里就是一个漏口。
            const text = textIn(e.data);
            const bound = state.session;
            const at = settleTarget(e, bound);
            state.composing = false;
            state.provisional = '';
            state.session = null;
            if (at.lost) {
              // ⚠️ 目标文本整份没了（视图已被换掉 / 文档被替换）⇒ ⛔ 不许往任何偏移里写。
              //    说清楚是"丢弃"，⛔ 不许静默当成"没这回事"。
              state.swallow = null;
              state.pending = [];
              return { applied: false, stale: true, why: '组合目标已失效：丢弃暂存输入' };
            }
            if (text.length === 0) {
              // ⚠️ 空结果是"这次组合什么都没上屏"，**不是**"这段时间什么都没发生"：
              //    组合期间粘贴进来的内容是另一个用户动作，照样要补一条（⛔ 丢内容）。
              //    ⚠️ 位置同样按 `settleTarget`：当前选区优先，⛔ 退回起手偏移。
              state.swallow = null;
              if (state.pending.length > 0) {
                const extra = state.pending.join('');
                state.pending = [];
                tx(at.from, at.from, extra.split('\n'), 'paste-after-composition');
                return {
                  applied: true,
                  rebased: at.rebased === true,
                  why: '组合被取消（空结果），但补上组合期间粘贴的内容',
                };
              }
              return { applied: false, why: '组合被取消（空结果）' };
            }
            // ⭐ 只落**一条文本事务**：组合期间攒下的字一次性进去。
            //    ⚠️ 区间取 `settleTarget` 的结论：当前选区优先，旧偏移只在没有当前值时兜底。
            tx(at.from, at.to, text.split('\n'), 'composition');
            state.swallow = text;
            // ⚠️ 组合期间粘贴过 ⇒ 在**组合结果之后**补一条，⛔ 不丢。
            if (state.pending.length > 0) {
              const extra = state.pending.join('');
              state.pending = [];
              const caret = at.from + text.length;
              tx(caret, caret, extra.split('\n'), 'paste-after-composition');
            }
            return {
              applied: true,
              rebased: at.rebased === true,
              why: at.rebased ? '组合结束：目标已变，按当前选区落定' : '组合结束：落一条事务',
            };
          }

          case 'beforeinput': {
            if (isComposingEvent(e, state)) {
              return { applied: false, why: '组合中的 beforeinput：交给 compositionend' };
            }
            const type = e.inputType;

            // ⛔ 撤销/重做由我们自己分派（`model.js::resolveUndo`）：
            //    放给浏览器就是在两套历史之间来回切（`design/0047` §2.6）。
            if (type === 'historyUndo' || type === 'historyRedo') {
              // ⚠️ 这也是**另一个用户动作** ⇒ 结束"组合结束后的待吞"生命周期。
              //    否则撤销之后敲回同一个字，会被当成浏览器补发的那一发吞掉。
              state.swallow = null;
              return { applied: false, why: '撤销重做由我们分派，⛔ 不交给浏览器' };
            }

            if (isInsertType(type)) {
              const text = textIn(e.data);
              if (text.length === 0) return { applied: false, why: '空插入' };
              if (trySwallow(e, text)) {
                return { applied: false, why: '组合结束后的重复 beforeinput：吃掉' };
              }
              tx(e.from, e.to, text.split('\n'), 'insert');
              return { applied: true, why: '插入' };
            }

            // ⚠️ 走到这里说明这**不是插入**（删除 / 格式 / 未处理的类型）——任何另一个
            //    用户动作都必须结束"组合结束后的待吞"生命周期（⛔ 让它跨动作存活）。
            state.swallow = null;

            if (isDeleteType(type)) {
              // ⚠️ 删除的**方向与粒度**（词 / 行 / 选区）由浏览器算好放在 `from`/`to` 里，
              //    ⛔ 我们不自己按 `inputType` 猜——那会与系统键位不一致。
              tx(e.from, e.to, [], 'delete');
              return { applied: true, why: '删除' };
            }

            return { applied: false, why: `未处理的 inputType ${type}` };
          }

          case 'input': {
            // ⭐ 顺序很重要：先判"这是不是组合产生的 input"
            if (isComposingEvent(e, state)) {
              return { applied: false, why: '组合中的 input：交给 compositionend' };
            }
            const text = textIn(e.data);
            if (text.length === 0) return { applied: false, why: '空 input' };
            if (trySwallow(e, text)) {
              return { applied: false, why: '组合结束后的重复 input：吃掉' };
            }
            tx(e.from, e.to, text.split('\n'), 'input');
            return { applied: true, why: '普通输入' };
          }

          case 'paste': {
            const text = textIn(e.text);
            if (text.length === 0) return { applied: false, why: '空粘贴' };
            if (state.composing) {
              // 组合中粘贴：⛔ 不动文档；记下来，等组合结束后补一条（⛔ 不并进 preedit）
              state.pending.push(text);
              return { applied: false, why: '组合中粘贴：记下来，组合结束后补一条' };
            }
            // ⚠️ 粘贴也是另一个用户动作 ⇒ 组合结束后的待吞到此为止
            //    （否则"组合 → 粘贴 → 敲回同一个字"会把真输入吞掉）。
            state.swallow = null;
            tx(e.from, e.to, text.split('\n'), 'paste');
            return { applied: true, why: '粘贴（已把 CRLF/CR 归一成 LF）' };
          }

          case 'cancel': {
            // `Esc` / 失焦：组合作废，⛔ 不落文本事务（与系统行为一致：未上屏的字丢掉）
            const was = state.composing;
            const bound = state.session;
            const at = settleTarget(e, bound);
            state.composing = false;
            state.provisional = '';
            state.session = null;
            state.swallow = null;
            // ⚠️ 但**已经粘贴进来**的文本不能丢：它是另一个用户动作，落一条独立事务。
            //    ⚠️ 位置同样按**当前**选区（`settleTarget`），⛔ 不用起手那一刻的旧偏移。
            // ⚠️ 目标整份没了（视图已被换掉 / 文档被替换）⇒ ⛔ 也不许落到任何偏移
            //    （与 `compositionend` 同一条判据：`lost` 就没有"当前位置"可写）。
            if (state.pending.length > 0 && at.lost) {
              state.pending = [];
              return { applied: false, stale: true, why: '组合目标已失效：丢弃暂存输入' };
            }
            if (state.pending.length > 0) {
              const extra = state.pending.join('');
              state.pending = [];
              tx(at.from, at.from, extra.split('\n'), 'paste-after-composition');
              return { applied: true, why: '组合取消，但补上组合期间粘贴的内容' };
            }
            return { applied: false, why: was ? '组合被取消' : '不在组合态' };
          }

          default:
            return { applied: false, why: `未处理的事件 ${e.type}` };
        }
      },
    };
  }

  /**
   * 组合结束后的光标位置（块内 UTF-16 偏移）。
   *
   * ⚠️ 口径是 **UTF-16 码元**（与 JS 字符串长度、以及 `offset.rs` 的展示层换算一致）。
   * ⛔ 不是字节、⛔ 不是字素簇——组合字符仍按码元算，这一条**本项目自定**（§2.1）。
   */
  function caretAfterComposition(startOffset, committedText) {
    return startOffset + String(committedText || '').length;
  }

  /**
   * `Enter` 的落点（`bugs/0108`「item 输入完一行之后 Enter，应该还是 item，RMD 变成正文了」＋
   * `bugs/0110`「已经写好的 Item，再次编辑换行的时候，Item 没有了」）：返回一条交给接线层的
   * 事务描述，`{type:'insert', data, from, to}`（`data` 已含续行前缀）或
   * `{type:'delete', data:'', from, to}`（空 item 回车 = 删掉标记退回正文）。
   *
   * ⭐ 与 Mardo 对齐的口径（`research/products/0005-mardo.md` §2.6）：按 Enter 续列表
   *    这类行为由**特性声明的数据**驱动（`EditorBehavior.linePrefix`），⛔ 不是撒在键盘
   *    处理里的 if——这里同构：由 `decorations.js::markers()` 的 `listLines` 品种记录驱动。
   *
   * 分支（⛔ 顺序即语义，别调换）：
   *   ① 有选区（`from !== to`）⇒ 裸 `\n`——选区回车是"替换"，不续列表；
   *   ② 列表行（`kind ≠ 'plain'`）**任意位置**回车 ⇒ 断成两项、新项续出同品种前缀
   *      ——与 Mardo 一致：在**已写好的项正文中间**按回车也把当前项一分为二，新项仍是
   *      列表项（`bugs/0110`）。前缀 = 源码切片：缩进与 `> ` 引用标记原样保留；有序项把
   *      编号换**下一个**（标点与尾随空白不变）；任务项把 `[x]`/`[X]` 换空框 `[ ]`。
   *      ⚠️ 插入点收敛到 `max(from, contentFrom)`：光标落在隐藏标记区（行首）时不劈开
   *      `- [x] ` 这类标记，而是在**原项上方新起一个空项**（`bugs/0105` 的同族语义）；
   *      光标落在行尾纯空白里时收敛到 `lineEnd`（尾随空白留在原行）。
   *   ③ 空 item（正文为空）⇒ **先升一级**（`indentStep(-1)`：内层项回到上一级，子项跟着走；
   *      Notion / Mardo 口径，`bugs/0116` §10）；**已在最外层**（或引用里的首项）才 `delete`
   *      区间 [**markerFrom**, contentFrom)——只删**列表那一层**的标记，退回正文
   *      （Typora / Obsidian 通用惯例；⚠️ Mardo 未取证，见 `docs/bugs/0108` §5）。
   *      ⚠️ `> - ` 的一级标记起点是 `markerFrom = 2`，⛔ 不能连 `> ` 一起退（`bugs/0111` A2）；
   *      普通 `- ` 的 `markerFrom` 就是行首，行为与旧口径完全相同。旧 plan 缺 `markerFrom`
   *      ⇒ 退回 `li.from`。
   *   ④ **续行**（`kind === 'plain'`）⇒ 回车续出**它所属列表项**的同品种前缀
   *      （`bugs/0300` 现象二；2026-11-09 用户裁定，取代原先的"裸 `\n`"：
   *      「最后一行，输入 enter 之后，还是没有继承上一行的 todo Item」）。
   *      所属项 = 同一块里**前面最近**的一条非 `plain` 列表行（深度不深于续行）。
   *      前缀从**项那一行**的源码切，插入点仍在**当前续行**上（行中、行尾同）。
   *      ⚠️ **续行行首 / 缩进内**（`from <= 本行记录的 contentFrom`）例外：插**裸 `\n`**、
   *      ⛔ 不续前缀、⛔ 不用 `Math.max` 抬回 `contentFrom`（`bugs/0314`：否则多出一条只有
   *      缩进空白的行，续行还被提成新列表项）。
   *      ⚠️ 代码行（`rec.code === true`）不算续行：在列表项里的围栏代码块中回车
   *      必须仍是裸 `\n`，⛔ 不能往代码里塞 `- [ ] `。
   *   ⑤ **引用行**（`plan.quoteLines`，`bugs/0111` A1）：行内没有列表记录时，
   *      · `blank === true`（空引用行）⇒ `delete` [markerFrom, contentFrom)，**只退引用这一层**，
   *        ⛔ 不产 `> > `；⚠️ 光标在标记区里（`from < contentFrom`）时不动它（那是"在行首
   *        插入"，`bugs/0105` 同族；`bugs/0115` 的对称形态）；
   *      · 否则 ⇒ 在 `from` 插 `'\n' + 源码切片[from, contentFrom)`（多层引用就是 `> > `）。
   *      · plan 缺 `quoteLines` / 字段 ⇒ 退回旧行为（裸 `\n`）。
   *   ⑥ 都没有 ⇒ 裸 `\n`（行中、行尾同）。
   *   ⑦ **有序编号只有一份算式**（`bugs/0111` A3 / `0315`）：下一编号 =
   *      `项.number + 1`（装饰层按**位置**渲染出来的编号），⛔ 不再从 prefix 里
   *      `parseInt + 1`；标点取 `项.markerRaw` 最后一个非空白字符（`.` / `)`），
   *      拿不到就用 `.`。编号超上界（`plan.maxOrdered`，缺省 `999999999`）⇒ fail-closed
   *      到裸 `\n`——新行是正文段落，与阅读态一致（`design/0063` F4c：10 位不是列表标记）。
   *      ⚠️ 旧 plan 缺 `number` ⇒ 退回原来的 `parseInt + 1`（⛔ 不抛异常）。
   *
   * ⚠️ 行界与 `decorations.js` 同一口径（0-based 偏移，行末不含 `\n`）。
   * ⚠️ 单元格里的换行不走这里（`policy.text` 先把 `\n` 折成软换行，`main.js` 不会打
   *    `insertLineBreak`）⇒ 本函数与表格语义无交集。
   *
   * @param {string} text 块内源码（恒 LF；`normalizeNewlines` 之后的形态）。
   * @param {{listLines?:Array<{line:number,from:number,contentFrom:number,depth:number,kind:string,
   *     marker:string, markerFrom?:number, markerRaw?:string, number?:number|null,
   *     checked?:boolean, code?:boolean}>,
   *   quoteLines?:Array<{line:number,from:number,markerFrom:number,contentFrom:number,blank:boolean}>,
   *   maxOrdered?:number}|null|undefined} plan
   *   装饰层的 `markers()` 结果（只读 `listLines` / `quoteLines` / `maxOrdered`；
   *   字段缺失 ⇒ 一律退回旧行为，⛔ 不抛异常）。
   * @param {number} from 事务起点（与 `to` 相同 = 光标）。
   * @param {number} to 事务终点。
   * @returns {{type:string,data:string,from:number,to:number,
   *   sel?:{anchor:number, head:number}}}
   */
  function lineBreakAction(text, plan, from, to) {
    const out = { type: 'insert', data: '\n', from: from, to: to };
    if (from !== to) return out;
    const s = String(text == null ? '' : text);
    const starts = [];
    for (let i = 0; i <= s.length; i++) {
      if (i === 0 || s.charCodeAt(i - 1) === 10) starts.push(i);
    }
    let n = starts.length - 1;
    while (n > 0 && starts[n] > from) n--;
    const lineStart = starts[n];
    const lineEnd = n + 1 < starts.length ? starts[n + 1] - 1 : s.length;
    if (from > lineEnd) return out;
    const list = plan && plan.listLines;
    let li = null;
    let 位 = -1;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].from === lineStart) { li = list[i]; 位 = i; break; }
      }
    }
    // ⭐ 续行（`kind === 'plain'` ∧ 不是代码行）往上找**所属列表项**：同一块里前面最近、
    //    深度不深于自己的那条非 `plain` 行。深度由 `decorations.js`「续行补深度」回填，
    //    与所属项的深度相等；嵌套项的内层续行只会遇到自己的项（外层的浅，不会被误取）。
    let 项 = li;
    if (li && li.kind === 'plain' && li.code !== true && list) {
      const 深 = typeof li.depth === 'number' ? li.depth : 0;
      for (let i = 位 - 1; i >= 0; i--) {
        const r = list[i];
        if (r.kind === 'plain' || r.code === true) continue;
        if ((typeof r.depth === 'number' ? r.depth : 0) > 深) continue;
        项 = r;
        break;
      }
    }
    const 是列表项 = !!li && (项 !== li
      || (li.kind !== 'plain'
        && typeof li.contentFrom === 'number'
        && li.contentFrom > lineStart && li.contentFrom <= lineEnd));
    // ④′ 续行的**行首 / 缩进内**（`bugs/0314`）：新行留在列表里，但 ⛔ 不再写一遍前缀。
    //    判据 `from <= 本行记录的 contentFrom`——光标在行首与正文起点之间（含正文起点）
    //    都是"本行还没有可拆的正文"；行中 / 行尾（`from > contentFrom`）仍是 `0300` 现象二。
    //    ⚠️ 这里⛔ 不能用 `Math.max` 抬回 `contentFrom`：那正是 0105 的行首保护被抵消的地方。
    if (li && li.kind === 'plain' && li.code !== true
        && typeof li.contentFrom === 'number' && from <= li.contentFrom) {
      return { type: 'insert', data: '\n', from: from, to: from };
    }
    // ⑤ 引用行（`bugs/0111` A1）：没有列表记录时按**装饰层同一份** `quoteLines` 续 / 退引用。
    if (!是列表项) {
      const q = 引用行(plan, lineStart, n);
      if (q) {
        const qFrom = typeof q.markerFrom === 'number' ? q.markerFrom : q.from;
        const qTo = typeof q.contentFrom === 'number' ? q.contentFrom : -1;
        if (q.blank === true) {
          // 空引用行（`> ` / `>`）：删掉整条前缀链 = 退出引用，⛔ 不产 `> > `。
          //  ⚠️ 光标在标记区里（`from < contentFrom`）时按"行首插入"处理（`bugs/0105` 同族），
          //   ⛔ 不删——否则会把标记从光标后面抽走（`bugs/0115` 的对称形态）。
          if (typeof qFrom === 'number' && qTo > qFrom && from >= qTo) {
            return { type: 'delete', data: '', from: qFrom, to: qTo };
          }
          return out;
        }
        // 有正文的引用行：新行续 `> `（多层就是 `> > `，源码切片原样带走）。
        if (typeof q.from === 'number' && qTo > q.from) {
          return { type: 'insert', data: '\n' + s.slice(q.from, qTo), from: from, to: from };
        }
      }
      return out;
    }
    // ③ 空 item：删标记退列表（区间 = [markerFrom, contentFrom)；空项的正文段全是空白）。
    //    ⚠️ 只对**项行本身**——续行没有标记可删（删掉的会是所属项的标记）。
    //    ⚠️ 起点用 `markerFrom`（标记本身），⛔ 不是行首：`> - ` 只能退 `- `（`bugs/0111` A2）。
    if (项 === li && s.slice(li.contentFrom, lineEnd) === '') {
      // ⭐⭐ **空项回车先升一级**（`bugs/0116` §10，2026-11-14 用户：「多级有序和无序列表
      //    使用的体验，感觉比 Mardo 差不少事」）：Notion / Mardo 里，在多级列表的**内层**
      //    空项上回车是"回到上一级"，只有在**最外层**空项上回车才退出列表。旧实现无条件
      //    退列表 ⇒ `1. 甲 /   1. 甲一` 里对甲一回车，整条列表当场结束。
      //    ⚠️ 复用 `indentStep(-1)`：它已经负责"子项跟着走""空白只有一层"这些口径；
      //    它的 `sel` 正好是这条用例要的光标——光标在 `contentFrom`，删掉的空白全在它
      //    左边 ⇒ 映射落到新行的正文起点，⛔ 不用在这里另算一份。
      //    ⚠️ 顶层项 / 引用里的首项（没有更浅的缩进）会拿到 `noop` ⇒ 走下面的退列表分支。
      const 升 = indentStep(s, plan, from, from, -1);
      if (升 && 升.type !== 'noop'
          && typeof 升.from === 'number' && typeof 升.to === 'number') {
        return {
          type: 升.type,
          data: typeof 升.data === 'string' ? 升.data : '',
          from: 升.from,
          to: 升.to,
          sel: 升.sel,
        };
      }
      let 起 = li.from;
      // ⚠️ `[行首, markerFrom)` 里只有**空白**（纯缩进）时连缩进一起删——否则会留下一条
      //    只含空白的行（`bugs/0314` 同一族缺陷）。有引用标记（`> `）时只能从标记起删
      //    （`bugs/0111` A2：⛔ 不吞 `> `）。
      if (typeof li.markerFrom === 'number'
          && li.markerFrom >= li.from && li.markerFrom <= li.contentFrom
          && s.slice(li.from, li.markerFrom).trim() !== '') 起 = li.markerFrom;
      return { type: 'delete', data: '', from: 起, to: li.contentFrom };
    }
    // ② 插入点收敛：标记区里的光标当作"正文起点"，尾随空白里的光标当作"行尾"。
    let at = Math.max(from, li.contentFrom);
    let 尾 = true;
    for (let i = at; i < lineEnd; i++) {
      const c = s.charCodeAt(i);
      if (c !== 32 && c !== 9) { 尾 = false; break; }
    }
    if (尾) at = lineEnd;
    // ② 前缀 = **项那一行**的源码切片（续行也切这一行，⛔ 不是当前续行的）；
    //    有序项换"下一编号"，任务项换空框。
    let prefix = s.slice(项.from, 项.contentFrom);
    if (项.kind === 'ordered') {
      // ⑦ 编号只有一份来源（`bugs/0111` A3）：装饰层按**位置**渲染出的 `number + 1`。
      //    ⛔ 不再从 prefix 里 `parseInt + 1`（那是与渲染不一致的第二套算式）。
      if (typeof 项.number === 'number') {
        const 下一 = 项.number + 1;
        const 上限 = plan && typeof plan.maxOrdered === 'number' ? plan.maxOrdered : 999999999;
        // `0315`：新编号越过合法上界（10 位不是列表标记）⇒ fail-closed 到裸 `\n`，
        // 新行是正文段落——与阅读态（Rust/comrak 的权威结构）一致，⛔ 不写十位编号。
        if (!(下一 <= 上限)) return { type: 'insert', data: '\n', from: at, to: at };
        const 标点 = 编号标点(项.markerRaw);
        // 只替换**末尾的编号段**：`> ` / 缩进 / `[ ] ` 一个字节都不动。
        const m = /(\d{1,9})[.)]([ \t]*)$/.exec(prefix);
        if (!m) return { type: 'insert', data: '\n', from: at, to: at };
        prefix = prefix.slice(0, m.index) + String(下一) + 标点 + m[2];
      } else {
        // 旧 plan（没有 `number`）：保持原行为，⛔ 不抛异常。
        prefix = prefix.replace(/(\d{1,9})([.)])([ \t]*)$/, function (m, num, punct, ws) {
          return String(parseInt(num, 10) + 1) + punct + ws;
        });
      }
    } else if (项.kind === 'task') {
      prefix = prefix.replace(/\[[xX ]\]/, '[ ]');
    }
    return { type: 'insert', data: '\n' + prefix, from: at, to: at };
  }

  /**
   * 有序标记的**标点**：取源码原始标记（`'3.'` / `'3)'`）最后一个非空白字符。
   * 拿不到（旧 plan / 空串）或不是 `.` / `)` ⇒ 回落 `.`（`bugs/0111` A3：
   * 新行标点与源码保持一致，⛔ 一律写点）。
   * @param {string|undefined|null} raw
   * @returns {string}
   */
  function 编号标点(raw) {
    const t = String(raw == null ? '' : raw).replace(/[ \t]+$/, '');
    const c = t.charAt(t.length - 1);
    return c === '.' || c === ')' ? c : '.';
  }

  /**
   * 在 `plan.quoteLines` 里找**本行**的引用记录（`bugs/0111` A1）。
   * ⚠️ 旧 plan（没有这个字段）⇒ `null`，调用方退回旧行为。
   * @param {{quoteLines?:Array<{line:number,from:number,markerFrom:number,contentFrom:number,
   *   blank:boolean}>}|null|undefined} plan
   * @param {number} lineStart
   * @param {number} lineNo
   * @returns {{line:number,from:number,markerFrom:number,contentFrom:number,blank:boolean}|null}
   */
  function 引用行(plan, lineStart, lineNo) {
    const qs = plan && plan.quoteLines;
    if (!qs) return null;
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (q.from === lineStart || q.line === lineNo) return q;
    }
    return null;
  }

  /**
   * ⭐⭐ **列表项缩进 / 反缩进的一步**（`bugs/0116`，2026-11-13 用户裁定）。
   *
   * 用户原话：「输入多级 List Item 是，一般加一个 tab，或者平级的 list Item 加一个 tab
   * 就变成下一级的，这是通用体验，RMD 对 TAB 支持很差，明显有问题。
   * 重点参考 Notion Mardo 的输入和展示体验。」
   *
   * # 口径（与 Notion / Mardo 一致的那几条）
   *
   * 1. **降一级**：本行缩进到**前一条同级项**的正文列。CommonMark 只要求"子项缩进 ≥
   *    父项的正文列"，所以正文列就是最小且唯一确定的答案（`- ` ⇒ 2、`1. ` ⇒ 3、
   *    `10. ` ⇒ 4、`> - ` ⇒ 4）。⛔ 不用一个写死的"每级 2/4 空格"——那会让
   *    `1.` / `10.` 两种标记的深度算错。
   * 2. **没有前一条同级项**（本项是自己那一层的第一项）⇒ **什么都不做**（Notion 口径：
   *    按 `Tab` 是把块挂到**前一个块**下面，前面没有块就没有可挂的地方）。⚠️ 不能让
   *    它"按自身标记宽再缩一级"：有子项时父项会与子项缩到同一列，子项被提成兄弟、
   *    有序列表被劈成两个（实测 `1. 甲 /   1. 甲一 /      1. 甲一一`，`Tab` 甲一）。
   *    多行选区里只跳过这一项，其余项照常缩。
   * 3. **子项随父项一起走**：缩进一个列表项时，**缩进列更深**的后续项（它的子项）
   *    按同一个步长一起移动。⛔ 只动父项会让父项与子项同列（同上一条的劈开形态）。
   * 4. **升一级**：缩进回到**上一级项**（前面最近的、缩进列更小的那一项）的缩进位置；
   *    子项同样跟着走。没有上一级的项跳过；一条都动不了 ⇒ `noop`。
   *    一级列表（深度 0）**什么都不做**——Notion 里 ⇧Tab 也不会把列表项变成段落；
   *    退出列表仍是"空项回车"与"行首退格"（`lineBreakAction` ③ / `deleteRange`）。
   * 5. **续行跟着它所属的项走**：光标落在列表项的续行（`kind === 'plain'`）上时，
   *    目标换成所属项的标记行（与 `lineBreakAction` ④ 同一个归属判据）。
   * 6. **多行选区**：按**第一条可动的行**算出统一的缩进量，整段一起缩
   *    （⛔ 不逐行各算各的——那会让相对结构在选区内被拆散）。行内空白、代码行、
   *    空白行不参与，也不因此把整段判成"不可缩进"。
   *
   * # 返回值
   *
   * · `null` —— 光标根本不在列表行上（调用方保持原来的 `Tab` 语义：提交并退出）；
   * · `{type:'noop'}` —— 在列表里但这一步没有可改的东西（一级列表的 ⇧Tab、
   *   选区里一条列表行都没有）⇒ 调用方**吃掉这个键**，⛔ 不退出这一块；
   * · `{type:'replace'|'delete', from, to, data, sel}` —— 一次文本替换（单行时退化成
   *   纯插入 / 纯删除，分别对应 `replace` / `delete`），`sel` 是映射之后的选区
   *   （⛔ 不让光标跳到行尾）。
   *
   * ⚠️ **纯函数**：不碰 DOM、不读 `view`；`plan` 是装饰层 `markers()` 的结果
   *    （`listLines` 为准）。⚠️ plan 缺失 / 字段不全 ⇒ 当"不在列表里"（`null`），
   *    ⛔ 不猜一份缩进规则出来。
   *
   * @param {string} text 块内源码（恒 LF）
   * @param {{listLines?:Array<{line:number,from:number,contentFrom:number,depth:number,
   *   kind:string,marker:string,markerFrom?:number,markerRaw?:string,code?:boolean}>}|null|undefined} plan
   * @param {number} from 选区起点
   * @param {number} to 选区终点（与 `from` 相同 = 光标）
   * @param {number} dir `+1` 降一级 / `-1` 升一级
   * @returns {{type:string, from?:number, to?:number, data?:string,
   *   sel?:{anchor:number, head:number}}|null}
   */
  function indentStep(text, plan, from, to, dir) {
    const s = String(text == null ? '' : text);
    const list = plan && plan.listLines;
    if (!list || list.length === 0) return null;
    let f = Number.isInteger(from) ? from : 0;
    let t = Number.isInteger(to) ? to : f;
    if (t < f) { const x = f; f = t; t = x; }
    f = Math.max(0, Math.min(f, s.length));
    t = Math.max(f, Math.min(t, s.length));

    // ── 行界（与 `lineBreakAction` / 装饰层同一口径：0-based，行末不含 `\n`）──
    const starts = [0];
    for (let i = 1; i <= s.length; i++) {
      if (s.charCodeAt(i - 1) === 10) starts.push(i);
    }
    /** @param {number} off */
    function 行号(off) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= off) lo = mid; else hi = mid - 1;
      }
      return lo;
    }
    /** @param {number} i */
    function 行末(i) {
      return i + 1 < starts.length ? starts[i + 1] - 1 : s.length;
    }

    /** @type {Map<number, any>} */
    const recOf = new Map();
    /** @type {Map<any, number>} */
    const 序 = new Map();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || typeof r.from !== 'number') continue;
      if (!recOf.has(r.from)) recOf.set(r.from, r);
      序.set(r, i);
    }
    /** @param {any} rec */
    function 深度(rec) { return typeof rec.depth === 'number' ? rec.depth : 0; }
    /** 行首到标记之间的字符数（含引用前缀 `> `）。 @param {any} rec */
    function 缩进(rec) {
      return (typeof rec.markerFrom === 'number' ? rec.markerFrom : rec.from) - rec.from;
    }
    /** 标记 ＋ 其后空白占的列宽（= 子项要缩到的列）。 @param {any} rec */
    function 列宽(rec) {
      const 缩 = 缩进(rec);
      // ⚠️ 兜底用 `markerRaw`（源码列）而不是 `marker`（**显示**字形）：`marker` 自
      // `bugs/0116` §9 起可能是 `a.` / `iv.`，而写回源码的缩进必须按 `3.` 那位宽算。
      let 宽 = typeof rec.contentFrom === 'number' ? rec.contentFrom - rec.from
        : 缩 + String(rec.markerRaw || rec.marker || '-').length + 1;
      // ⚠️ 任务项的 `contentFrom` 把 `[x] ` 也算进去了，但嵌套只认列表标记那一段。
      if (rec.kind === 'task') 宽 -= 4;
      return Math.max(缩 + 1, 宽);
    }
    /** 前一条**同级**项（深度相同；遇到更浅的就说明没有同级项了）。 @param {any} rec */
    function 同级前一(rec) {
      const i0 = 序.get(rec);
      if (i0 === undefined) return null;
      const d = 深度(rec);
      for (let i = i0 - 1; i >= 0; i--) {
        const r = list[i];
        if (!r || r.kind === 'plain' || r.code === true) continue;
        const rd = 深度(r);
        if (rd === d) return r;
        if (rd < d) return null;
      }
      return null;
    }
    /**
     * 上一级项 = 前面最近的、**缩进更小**的那一条列表项。
     * ⚠️ 判据用**缩进列**而不是 `depth`：装饰层的 `depth` 会把"列表装在引用里"也算一层
     *    （`列表几何` 的 `hostKind`），照它回退会去啃 `> ` 后面那个空格 ⇒ `> - 甲`
     *    被写成 `>- 甲`（同一条列表，只是前缀变形）。缩进更小才是"真的还有上一级"。
     * @param {any} rec
     */
    function 浅缩进前一(rec) {
      const i0 = 序.get(rec);
      if (i0 === undefined) return null;
      const 自 = 缩进(rec);
      for (let i = i0 - 1; i >= 0; i--) {
        const r = list[i];
        if (!r || r.kind === 'plain' || r.code === true) continue;
        if (缩进(r) < 自) return r;
      }
      return null;
    }
    /** 续行所属的列表项（与 `lineBreakAction` ④ 同一判据）。 @param {any} rec */
    function 所属项(rec) {
      const i0 = 序.get(rec);
      if (i0 === undefined) return null;
      const d = 深度(rec);
      for (let i = i0 - 1; i >= 0; i--) {
        const r = list[i];
        if (!r || r.kind === 'plain' || r.code === true) continue;
        if (深度(r) > d) continue;
        return r;
      }
      return null;
    }

    // ── 选出要改的那几行 ────────────────────────────────────────────
    let 末行 = 行号(t);
    // 选区正好停在行首（`to` 落在下一行的第 0 列）⇒ 那一行不算被选中（编辑器通用口径）。
    if (t > f && t === starts[末行] && 末行 > 0) 末行--;
    const 首行 = 行号(f);
    /** @type {Set<number>} */
    const 见过 = new Set();
    /** @param {any} rec */
    function 收(rec) {
      if (!rec || !Number.isInteger(rec.from) || 见过.has(rec.from)) return;
      见过.add(rec.from);
    }
    for (let i = 首行; i <= 末行; i++) {
      const 起 = starts[i];
      const 文 = s.slice(起, 行末(i));
      const r = recOf.get(起);
      if (!r || r.code === true) continue;
      if (r.kind !== 'plain') {
        // 空行不会出现在这个分支（空行是 plain）；列表项行本身可以是空的（`-`）。
        收(r);
        continue;
      }
      // 空白行不是列表内容 ⇒ 不参与（Tab 保持"离开"）。
      if (文.trim() === '') continue;
      收(所属项(r));   // 续行 ⇒ 改它所属的那一项（⛔ 不给续行单加缩进）
    }
    if (见过.size === 0) return null;
    // ⚠️ 顺序直接沿用装饰层的 `listLines`（它按行升序）⇒ 只按源码偏移取子集，
    //    ⛔ 这里**不许** `.sort(`（`tests/js/doclist-source.test.js` 的排序闸门：
    //    第二份顺序不许散落在前端；续行解析出的所属项可能比当前行更靠前）。
    /** @type {any[]} */
    const 目标 = [];
    const 已收 = new Set();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || !见过.has(r.from) || 已收.has(r.from)) continue;
      已收.add(r.from);
      目标.push(r);
    }
    if (目标.length === 0) return null;

    // ⭐⭐ Notion 口径（2026-11-14，用户「多级有序列表参考 Notion 的实现」）：
    //    `Tab` 是把块挂到**前一个同级块**下面；前面没有块 ⇒ 没有可挂的地方，**不动**。
    // ⚠️ 旧实现让首项"按自身标记宽再缩一级"，那在**有子项**时会把父项与子项缩到同一列
    //    ⇒ 子项被提成兄弟、有序列表被劈成两个（实测：`1. 甲 /   1. 甲一 /      1. 甲一一`，
    //    `Tab` 甲一 ⇒ 甲一与甲一一同列）。⇧Tab 同理：没有上一级的项跳过。
    // ⚠️ 多行选区里逐项判定：跳过动不了的那几项，其余照常（相当于 Notion 逐块执行）。
    /** @param {any} rec */
    function 可移(rec) {
      return dir > 0 ? !!同级前一(rec) : !!浅缩进前一(rec);
    }
    /** @type {any[]} */
    const 起缩 = [];
    for (let i = 0; i < 目标.length; i++) if (可移(目标[i])) 起缩.push(目标[i]);
    if (起缩.length === 0) return { type: 'noop' };

    // ── 统一的缩进量（由第一条**真的要动**的目标行定）────────────────
    const 首 = 起缩[0];
    const 首缩 = 缩进(首);
    let 步 = 0;
    if (dir > 0) {
      const 前 = 同级前一(首);
      // ⚠️ `可移` 已经保证有前一条同级项；这里留空值判断是为了让"判据被改坏"时
      //    退化成 `noop`，⛔ 不是 `TypeError`（变异自检要看的是判据变红，不是崩溃）。
      步 = 前 ? 列宽(前) - 首缩 : 0;
    } else {
      const 爸 = 浅缩进前一(首);
      步 = 爸 ? 首缩 - 缩进(爸) : 0;
    }
    if (!(步 > 0)) return { type: 'noop' };
    const 空 = ' '.repeat(步);

    // ── 子项随父项一起走（Notion：移动一个块，它的子块跟着走）──────────
    // ⛔ 只改父项会让父项缩进后与子项同列 ⇒ 子项被提成兄弟。判据与 `浅缩进前一`
    //    同口径：**缩进列更深**的后续列表项就是它的子项（续行/代码行不参与）。
    /** @type {number[]} */
    const 动列 = [];
    /** @type {any[]} */
    const 全部 = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || typeof r.from !== 'number' || r.kind === 'plain' || r.code === true) continue;
      const 缩 = 缩进(r);
      while (动列.length > 0 && 缩 <= 动列[动列.length - 1]) 动列.pop();
      const 自 = 起缩.indexOf(r) >= 0;
      if (自 || 动列.length > 0) 全部.push(r);
      if (自) 动列.push(缩);
    }
    /** 本次真的要改的那些行的字节（`要改号` 用它判断"上一行也一起移了没有"）。 @type {Set<number>} */
    const 移 = new Set();
    for (let i = 0; i < 全部.length; i++) 移.add(全部[i].from);

    // ── ⭐ `bugs/0321`：降级之后必须还是一条**真的**子列表 ────────────────
    // CommonMark §5.2：**打断段落**的有序项必须从 `1` 起，否则整行退化成上一项的正文
    // （实测 comrak：`1. 甲\n   2. 乙` ⇒ `<li>甲<br />2. 乙</li>`，不是子列表）。
    // ⚠️ 这是**展示与编辑不一致**的直接来源：编辑侧 Lezer 认它是子项、照子项画缩进与编号，
    //    阅读侧 comrak 把它渲染成同一段里的一行字。⇒ 降级时把编号写成 `1`
    //    （Notion 口径：新建的子列表恒从 1 开始）。
    // ⚠️ 不改号的三种情况：上一行是空行（本来就是真嵌套，`start=2` 照常渲染）、
    //    上一行是**同一个有序列表**里、降级后仍同列的兄弟项（在延长那个列表，⛔ 不该重排）、
    //    以及源码里的编号本来就是 `1`。
    /** 某一行的源码（不含换行）。 @param {number} i */
    function 行文(i) { return s.slice(starts[i], 行末(i)); }
    /**
     * 降级之后这一项会不会被上一个非空行吃掉（打断规则）。
     * @param {any} rec
     * @param {number} 新列 降级之后的缩进列
     * @returns {boolean}
     */
    function 要改号(rec, 新列) {
      const ln = 行号(rec.from);
      if (ln <= 0) return false;
      if (行文(ln - 1).trim() === '') return false;
      const 前 = recOf.get(starts[ln - 1]);
      if (前 && 前.kind === 'ordered') {
        // ⚠️ 上一行如果**也在本次要改的行里**（选中的或随父走的子项），它的列也加同一个 `步`。
        const 前列 = 缩进(前) + (移.has(前.from) ? 步 : 0);
        if (前列 === 新列) return false;   // 同一个有序列表 ⇒ 不改号
      }
      return true;
    }
    /**
     * 写进标记区的新文本：缩进 ＋（必要时）`1` ＋ 原标点。
     * ⚠️ `markerRaw` 不是 `\d{1,9}[.)]` 的形态（旧 plan / 空串）⇒ 只加缩进，⛔ 不猜。
     * @param {any} rec
     * @param {boolean} 改
     * @returns {string}
     */
    function 标记插入(rec, 改) {
      if (!改) return 空;
      const 原 = String(rec.markerRaw || '');
      if (!/^\d{1,9}[.)]$/.test(原)) return 空;
      if (parseInt(原, 10) === 1) return 空;
      return 空 + '1' + 编号标点(原);
    }

    // ── 逐行编辑（位置都在标记之前，互不重叠）────────────────────────
    /** @type {Array<{pos:number, del:number, ins:string}>} */
    const edits = [];
    for (let i = 0; i < 全部.length; i++) {
      const rec = 全部[i];
      const 位 = typeof rec.markerFrom === 'number' ? rec.markerFrom : rec.from;
      if (dir > 0) {
        // ⚠️ 缩进与改号必须是**同一条** edit（位置都在 `markerFrom`）：
        //    拆成两条会重叠，而 `映射` 是按"互不重叠"算偏移的。
        // ⚠️ 只有**真的重写了编号**才能带 `del`：否则会把标记本身删掉
        //    （第一次实施就踩了：`   1. 乙` 降级成 `       乙`）。
        let ins = 空;
        let del = 0;
        if (rec.kind === 'ordered' && typeof rec.markerFrom === 'number') {
          const 新 = 标记插入(rec, 要改号(rec, 缩进(rec) + 步));
          if (新 !== 空) { ins = 新; del = String(rec.markerRaw || '').length; }
        }
        edits.push({ pos: 位, del: del, ins: ins });
        continue;
      }
      let p = 位;
      let n = 0;
      while (n < 步 && p > rec.from) {
        const c = s.charCodeAt(p - 1);
        if (c !== 32 && c !== 9) break;
        p--;
        n++;
      }
      if (p < 位) edits.push({ pos: p, del: 位 - p, ins: '' });
    }
    if (edits.length === 0) return { type: 'noop' };

    // ── 选区映射（插入点右侧整体右移，落进被删空白的夹到区间起点）────
    /** @param {number} p */
    function 映射(p) {
      let 偏 = 0;
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const 终 = e.pos + e.del;
        if (p >= 终) { 偏 += e.ins.length - e.del; continue; }
        if (p > e.pos) return e.pos + 偏;
        break;
      }
      return p + 偏;
    }
    const sel = { anchor: 映射(f), head: 映射(t) };

    // 单行 ⇒ 退化成纯插入 / 纯删除（历史分组与手敲一样近）。
    if (edits.length === 1) {
      const e = edits[0];
      // ⚠️ 纯删除不能走 `insert` 那一支：状态机会按"空插入"拒掉（`data === ''`）。
      return {
        type: e.ins === '' ? 'delete' : 'replace',
        from: e.pos,
        to: e.pos + e.del,
        data: e.ins,
        sel: sel,
      };
    }

    // 多行 ⇒ 一条替换（区间取整行，⛔ 不逐行发多条事务）。
    let lo = starts[首行];
    let hi = 行末(末行);
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      lo = Math.min(lo, starts[行号(e.pos)]);
      hi = Math.max(hi, 行末(行号(e.pos + e.del)));
    }
    let data = '';
    let cur = lo;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      data += s.slice(cur, e.pos) + e.ins;
      cur = e.pos + e.del;
    }
    data += s.slice(cur, hi);
    return { type: 'replace', from: lo, to: hi, data: data, sel: sel };
  }

  /**
   * `Tab`：列表项降一级（`bugs/0116`）。语义与返回值见 [`indentStep`]。
   * @param {string} text
   * @param {object|null|undefined} plan
   * @param {number} from
   * @param {number} to
   */
  function indentList(text, plan, from, to) {
    return indentStep(text, plan, from, to, 1);
  }

  /**
   * `⇧Tab`：列表项升一级（`bugs/0116`）。语义与返回值见 [`indentStep`]。
   * @param {string} text
   * @param {object|null|undefined} plan
   * @param {number} from
   * @param {number} to
   */
  function outdentList(text, plan, from, to) {
    return indentStep(text, plan, from, to, -1);
  }

  /**
   * ⭐⭐ **行首退格：嵌套列表项升一级**（`bugs/0116` §10，2026-11-14）。
   *
   * 用户原话：「多级有序和无序列表使用的体验，感觉比 Mardo 差不少事」。Notion / Mardo 里
   * 光标停在**内层项的正文起点**按退格是"回到上一级"（整项连同子项一起走），只有在
   * **最外层**按退格才删标记退出列表。旧实现直接走 `selection.js::deleteRange`：
   * 装饰层把 `缩进 + 标记` 藏成**一条**隐藏区间（`/tmp` 实测 `   - 乙` ⇒ `[5,10)`），
   * 于是内层项一按退格就整条缩进没了、项被提成段落——与 Notion 的"一级一级退"差一级。
   *
   * # 判据（缺一条就交给 `deleteRange`，⛔ 不在这里重写退格）
   *
   * · 光标是**折叠**的（`from === to`）——有选区时退格是"删选中内容"；
   * · 光标正好在**某列表项的 `contentFrom`**（行首隐藏标记区的右端 = 用户眼里的行首）；
   * · 该行是**项行本身**（`kind !== 'plain'`、不是代码行）——续行行首退格是"并进上一行"；
   * · `indentStep(-1)` 真的动了东西（`noop` = 顶层项 / 引用里的首项 ⇒ 旧行为：删标记）。
   *
   * # 返回值
   *
   * `{type:'replace'|'delete', from, to, data, sel}`（语义与 [`indentStep`] 相同）或 `null`
   * （调用方继续走原来的退格路径）。
   *
   * @param {string} text 块内源码（恒 LF）
   * @param {object|null|undefined} plan 装饰层 `plan`（只读 `listLines`）
   * @param {number} from 选区起点
   * @param {number} to 选区终点（与 `from` 相同 = 光标）
   * @returns {{type:string, from?:number, to?:number, data?:string,
   *   sel?:{anchor:number, head:number}}|null}
   */
  function outdentAtStart(text, plan, from, to) {
    if (from !== to) return null;
    const s = String(text == null ? '' : text);
    const list = plan && plan.listLines;
    if (!list || list.length === 0) return null;
    if (!Number.isInteger(from) || from < 0 || from > s.length) return null;
    // 行首（与 `lineBreakAction` 同一口径：0-based，行末不含 `\n`）。
    let 行起 = from;
    while (行起 > 0 && s.charCodeAt(行起 - 1) !== 10) 行起--;
    let rec = null;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r && typeof r.from === 'number' && r.from === 行起) { rec = r; break; }
    }
    if (!rec || rec.kind === 'plain' || rec.code === true) return null;
    // ⚠️ 严格相等：标记区里的位置不是"行首"，那里退格该删的是被藏的字符
    //    （`selection.js` 的隐藏区吸附已经保证光标不会停在那里，这里只是 fail-closed）。
    if (typeof rec.contentFrom !== 'number' || from !== rec.contentFrom) return null;
    const act = indentStep(s, plan, from, from, -1);
    if (!act || act.type === 'noop') return null;
    return act;
  }

  /**
   * ⭐ **空标题标记链后缺空格时补一个**（`bugs/0311`，2026-11-11 用户报告：
   * 「标题没有渲染出来」，截图里是 `##地方金额`）。
   *
   * # 场景与为什么它几乎必然发生
   *
   * 行里只有 `##` 时，comrak 把它解析成**空 ATX 标题**（CommonMark 允许"标记后就是行尾"）
   * ⇒ 标记恒藏（`design/0061` L1），屏幕上看不出后面**没有空格**。
   * 接着敲正文：`##` ＋ 正文 ≠ 标题（ATX 要求标记后跟空格或行尾）⇒ 整行当场退化成段落、
   * `##` 变回可见字符。而中文输入法里"空格"是**上屏候选**，⛔ 不产生字面空格
   * ⇒ 用户根本没机会打出那个分隔符，只觉得"标题没渲染"。
   *
   * ⇒ 判据收到一句话：**行首 1–6 个 `#` 顶到行首、光标正好在链尾、链后到行末全是空白**
   * 时，任何以非空白、非 `#` 开头的插入**自动补一个空格**（`#` 是在延长标记链，⛔ 不补）。
   *
   * ⚠️ **代码块 / HTML 块里的行一律不算**（`plan.codeLines`，`bugs/0102` 那份登记）：
   * 那里 `###` 是**内容**，补空格就是改用户的代码。
   * ⚠️ 行首有引用标记（`> ##`）或缩进（四空格代码缩进、列表项续行）时**不处理**：
   * 那些形态的"链"不顶行首，判据结构上就命不中（⛔ 不在这里另写一套前缀解析）。
   * ⚠️ 它只回答"要不要在前面加一个空格"，⛔ 不改行尾、⛔ 不碰选区、⛔ 不读 DOM。
   *
   * @param {string} lineText **光标所在那一行**的源码（不含换行；`doc.lineAt(from).text`）
   * @param {number} lineNumber 该行的 0-based 行号（只给 `plan.codeLines` 用）
   * @param {number} from 插入起点（**相对行首**的偏移）
   * @param {number} to 插入终点（与 `from` 不同 ⇒ 是替换，⛔ 不管）
   * @param {string} data 将要插入的文本
   * @param {{codeLines?:Object<string|number, boolean>}|null|undefined} plan
   *   装饰层 `markers()` 的结果（只读 `codeLines`；没有 ⇒ 不排除任何行）
   * @returns {string|null} 要**改用的**插入文本（`' ' + data`），`null` = 原样
   */
  function headingSpaceInsert(lineText, lineNumber, from, to, data, plan) {
    const s = String(lineText == null ? '' : lineText);
    const ins = String(data == null ? '' : data);
    if (from !== to || ins.length === 0) return null;
    const c = ins.charCodeAt(0);
    // 空白（用户自己打了分隔符）/ `#`（在把 `##` 延长成 `###`）/ 换行（Enter 那条路）都不补。
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 35) return null;
    let 标记 = 0;
    while (标记 < s.length && s.charCodeAt(标记) === 35) 标记++;
    // ATX：1–6 个 `#`，⛔ 7 个以上不是标题（那种行本来就该看见 `#`，别去"修"它）。
    if (标记 < 1 || 标记 > 6) return null;
    if (from !== 标记) return null;
    const code = plan && plan.codeLines ? plan.codeLines[lineNumber] : undefined;
    if (code === true) return null;
    for (let i = from; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch !== 32 && ch !== 9) return null;
    }
    return ' ' + ins;
  }

  const api = {
    normalizeNewlines: normalizeNewlines,
    linesOf: linesOf,
    isComposingEvent: isComposingEvent,
    createInputMachine: createInputMachine,
    caretAfterComposition: caretAfterComposition,
    lineBreakAction: lineBreakAction,
    indentList: indentList,
    outdentList: outdentList,
    outdentAtStart: outdentAtStart,
    headingSpaceInsert: headingSpaceInsert,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.rmd || (window.rmd = {})).liveInput = api;
})();
