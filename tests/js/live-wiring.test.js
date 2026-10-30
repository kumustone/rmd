// `design/0047` 的**接线闸门**（源码级）——`2026-10-26`。
//
// ⭐ 为什么必须是源码级：这条能力的判据全在 `src/live/**`（在 `node --test` 里跑得到），
//    而**把判据接上去的那一半**在 `src/main.js` —— 它**不进** `tests/js/`（加载期就要
//    整个应用：`window.rmd.*` 一大家族、真 IPC、真 DOM）。
//    ⇒ 「接线断了」这一族缺陷**任何断言都碰不到**，而且它们的表现**全部是静默的**：
//    ① `setupLive()` 排错位置（在配置快照回来之前）⇒ `S.state.liveEdit` 还是默认 `false`
//       ⇒ 整条能力**不接线**，单击正文什么都不发生、控制台一句话都没有；
//    ② `mountDocument` 里少了 `noteLive(payload)` ⇒ 块表与 DOM 的对齐表停在上一棵树，
//       表现是"点这一块，进的是另一块"或者"点了没反应"；
//    ③ 切换文档 / 重载 / 外部编辑器 / `⌘S` / `⌘E` 少一条脏闸 ⇒ 未写盘的提交**无声消失**
//       （`INV-LIVE-20` 那一族，用户看得到的是"我改的字没了"）；
//    ④ CM6 扩展白名单被悄悄放宽（多装一个带键位的扩展）⇒ "谁处理哪个键"变成两份事实；
//    ⑤ 字典里少一个 `status.live-*` 键 ⇒ 状态条上出现一串**键名**（`t()` 回落原样返回）；
//    ⑥ `swapLiveView` / `makeLiveView` 不搬被换掉那一块的**盒子**（`live/box.js`）⇒
//       换进去的 `div` 一个外边距都没有，正文整体上跳 `--reader-gap-block`（14px 下 **15.4px**）、
//       列表整体左跳一个缩进；而等高校验量的是 **border box**（`getBoundingClientRect().height`，**不含**外边距、**不含**横向）
//       ⇒ 这一条**任何行为判据都碰不到**，只有源码级断言守得住。
//    ⑦ `makeLiveView` 不把 `bodyLines` 交给装饰层 ⇒ 标题块里回车出来的新行仍是 28px/700
//       （`bugs/0015`，用户原话「下面一行一直是标题状态」）。⚠️ 纯逻辑判据只回答
//       "该给哪些行贴类"，⛔ 不回答"产品到底传没传" ⇒ 同样只有源码级断言守得住。
//    ⑧ `INV-KERNEL-05`／`design/0052` U6 被悄悄改回去：**块永远进得去**——几何差只许告警、
//       只许补滚动，⛔ 不许阻断进入。⚠️ 它的失效形态和上面几条同族：块"点了没反应"，
//       而探针的 B 段只有"进得去之后"的量 ⇒ 用户那一侧**一条判据都不会产生**。
//       ⭐ 配套的那半（锚定 `main.js::anchorAt`）同样只有源码级断言守得住：
//       少调一次 ⇒ 点进去下面的内容整体窜一行；调早一步 ⇒ 量的还是旧几何，补出来的滚动量是错的。
//
// ⚠️ 判据对**注释免疫**（本仓注释里到处都是"⛔ 别写成 X"，直接 grep 会把正确注释判成缺陷）。
// ⚠️ 变异自测在最后：同一套判据喂给"故意写坏的副本"必须变红——否则"全绿"只说明判据没看那一眼。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const SESSION = fs.readFileSync(path.join(ROOT, 'src', 'services', 'session.js'), 'utf8');
const CONFIG_RS = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'config', 'mod.rs'), 'utf8');
const CMDS_RS = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'commands', 'mod.rs'), 'utf8');
const I18N = require('../../src/services/i18n.js');
// ⭐ `bugs/0025`：几何闸门的允许量**必须只有一份**。探针那份源码也读进来——
//    它从前自己算了一遍（`fences + blanks + 有标记的行数`），产品只有前两项
//    ⇒ **探针比产品宽**，"探针全绿"推不出"用户点得进去"。
const HARNESS = fs.readFileSync(path.join(ROOT, 'tools', 'live-probe', 'block-harness.js'), 'utf8');

// ⭐ `design/0054`：**编辑对象的策略表**（单独读一份，判据要能精确地打红它）
const OBJECTS = fs.readFileSync(path.join(ROOT, 'src', 'live', 'objects.js'), 'utf8');
// ⭐ `bugs/0035`：单元格的换行往返（`encode`/`decode`）也要能单独打红
const CELLJS = fs.readFileSync(path.join(ROOT, 'src', 'live', 'cell.js'), 'utf8');
// ⭐ 2026-10-29 代码评审第 15 条：任务项的**武装**搬进了 `live/task.js`，判据跟着搬家
const TASKJS = fs.readFileSync(path.join(ROOT, 'src', 'live', 'task.js'), 'utf8');
// ⭐ `bugs/0042`–`0046`（2026-10-29 鼠标拖选五条）：选区的**接线**要能单独打红
const SELECTION = fs.readFileSync(path.join(ROOT, 'src', 'live', 'selection.js'), 'utf8');

const LIVE_FILES = ['model', 'blocks', 'objects', 'cell', 'task', 'selection', 'decorations', 'a11y', 'input', 'box', 'index'];

/** `src/live/**` 全部源码拼一份（字典键的收集面：控制器那边用的键 main.js 完全看不见）。 */
const LIVE_SRC = LIVE_FILES.map(function (name) {
  return fs.readFileSync(path.join(ROOT, 'src', 'live', name + '.js'), 'utf8');
}).join('\n');

function stripBlockComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

function stripLineComments(src) {
  return String(src).split('\n').map(function (line) {
    const i = line.indexOf('//');
    if (i < 0) return line;
    const before = line.slice(0, i);
    const quotes = (before.match(/["']/g) || []).length;
    if (quotes % 2 === 1) return line;
    return before;
  }).join('\n');
}

const HTML_CODE = stripBlockComments(HTML);
const MAIN_CODE = stripLineComments(stripBlockComments(MAIN));
const SESSION_CODE = stripLineComments(stripBlockComments(SESSION));
const CONFIG_CODE = stripLineComments(stripBlockComments(CONFIG_RS));
const CMDS_CODE = stripLineComments(stripBlockComments(CMDS_RS));
const HARNESS_CODE = stripLineComments(stripBlockComments(HARNESS));
const OBJECTS_CODE = stripLineComments(stripBlockComments(OBJECTS));
const CELL_CODE = stripLineComments(stripBlockComments(CELLJS));
const TASK_CODE = stripLineComments(stripBlockComments(TASKJS));
const SEL_CODE = stripLineComments(stripBlockComments(SELECTION));

/** 从 `function name(` 起截一段（判据只看函数头部附近，⛔ 不解析作用域）。 */
function sliceAfter(src, needle, len) {
  const at = src.indexOf(needle);
  if (at < 0) return '';
  return src.slice(at, at + (len || 3000));
}

function countOf(src, needle) {
  let n = 0;
  let at = src.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = src.indexOf(needle, at + needle.length);
  }
  return n;
}

/**
 * @param {{html:string, js:string, liveSrc:string, session:string, configRs:string,
 *          cmdsRs:string, dict:object, harness:string, objects:string, cellSrc:string,
 *          taskSrc:string, selSrc:string}} s
 * @returns {string[]} 失败项（空 = 全过）
 */
function score(s) {
  const bad = [];

  // ── ① 脚本组与样式表的落点 ─────────────────────────────────────────
  const mainAt = s.html.indexOf('<script src="main.js">');
  if (mainAt < 0) bad.push('index.html 里没有 <script src="main.js">');
  LIVE_FILES.forEach(function (name) {
    const tag = '<script src="live/' + name + '.js">';
    const at = s.html.indexOf(tag);
    if (at < 0) bad.push('index.html 少了 ' + tag);
    else if (mainAt >= 0 && at > mainAt) {
      bad.push(tag + ' 排在 main.js **之后** —— main.js 加载期就取 window.rmd.live*，会是 undefined');
    }
  });
  // ⚠️ `live.css` 必须是**最后一张**样式表：它压 typography.css 的 `.doc` 与 editor.css 的外壳。
  const links = s.html.match(/<link rel="stylesheet" href="[^"]+">/g) || [];
  if (!links.length) bad.push('index.html 里没扫到样式表，正则写错了？');
  else if (links[links.length - 1].indexOf('styles/live.css') < 0) {
    bad.push('styles/live.css 不是最后一张样式表（最后一张是 ' + links[links.length - 1] + '）');
  }

  // ── ② 开关链：出厂关、快照带出来、前端**严格**读 ───────────────────────
  if (!/pub live_edit:\s*Option<bool>/.test(s.configRs)) bad.push('config/mod.rs 没有 live_edit 字段');
  if (!/pub fn live_edit\(&self\)\s*->\s*bool\s*\{\s*self\.live_edit\.unwrap_or\(false\)\s*\}/.test(s.configRs)) {
    bad.push('config/mod.rs 的 live_edit() 默认值不是 false（§8：出厂关着）');
  }
  if (!/live_edit:\s*s\.config\.live_edit\(\)/.test(s.cmdsRs)) bad.push('snapshot() 没有带出 live_edit');
  if (!/state\.liveEdit\s*=\s*snap\.live_edit === true;/.test(s.session)) {
    bad.push('session.js 没有 `snap.live_edit === true`（⚠️ 真值判断会把 "false" 读成开）');
  }

  // ── ③ `setupLive()` 的挂点（错一位就是"整条能力不接线"）─────────────────
  const setupCalls = (s.js.match(/\bsetupLive\(\);/g) || []).length;
  if (setupCalls !== 1) bad.push('setupLive() 的调用出现 ' + setupCalls + ' 次（应恰好 1 次）');
  const snapLangAt = s.js.indexOf('applySnapshotLanguage(snap);');
  const setupAt = s.js.indexOf('setupLive();');
  // ⚠️ 启动文档那一次 `openDocument` 要取**最后一次**：前面的 `openDocument(` 是别处的调用点，
  //    用 `indexOf` 会拿到一个**排在 setupLive 之前**的锚 ⇒ 判据恒红（假阳性）。
  const startupAt = s.js.lastIndexOf('await openDocument(snap.startup_document);');
  if (snapLangAt < 0) bad.push('main.js 找不到 applySnapshotLanguage(snap)（挂点的前一个锚）');
  if (startupAt < 0) bad.push('main.js 找不到启动文档那一次 openDocument（挂点的后一个锚）');
  if (snapLangAt >= 0 && setupAt >= 0 && setupAt < snapLangAt) {
    bad.push('setupLive() 排在 applySnapshotLanguage 之前 —— 那时 S.state.liveEdit 还是默认 false');
  }
  if (setupAt >= 0 && startupAt >= 0 && setupAt > startupAt) {
    bad.push('setupLive() 排在启动文档之后 —— 第一份文档没有对齐表，点第一下恒 no-op');
  }

  // ── ④ 唯一提交点：`noteLive` 只许从 `mountDocument` 里调一次 ──────────────
  const noteCalls = countOf(s.js, 'noteLive(payload);');
  if (noteCalls !== 1) bad.push('noteLive(payload) 的调用出现 ' + noteCalls + ' 次（应恰好 1 次）');
  const mountAt = s.js.indexOf('function mountDocument(');
  const noteAt = s.js.indexOf('noteLive(payload);');
  if (mountAt < 0) bad.push('main.js 找不到 mountDocument');
  else if (noteAt >= 0 && noteAt < mountAt) bad.push('noteLive(payload) 不在 mountDocument 里');
  else {
    const after = s.js.slice(mountAt);
    const nextFn = after.indexOf('\n  function ', 10);
    const body = nextFn > 0 ? after.slice(0, nextFn) : after;
    if (body.indexOf('noteLive(payload);') < 0) bad.push('noteLive(payload) 在 mountDocument 的函数体之外');
  }

  // ── ⑤ 五条"会弄丢未写盘提交"的路都必须过闸 ────────────────────────────
  [
    ['async function openDocument(', '切换文档'],
    ['async function reloadCurrentDocument(', '重载'],
    ['function openExternalEditor(', '外部编辑器'],
    ['async function saveNow(', '⌘S'],
    ['function toggleEdit(', '⌘E'],
  ].forEach(function (pair) {
    const body = sliceAfter(s.js, pair[0], 3000);
    if (!body) { bad.push('main.js 找不到 ' + pair[0]); return; }
    if (!/live\.(isDirty|isEditing)\(\)/.test(body)) {
      bad.push(pair[1] + '（' + pair[0] + '）没有 live 脏闸 —— 未写盘的提交会无声消失');
    }
  });

  // ── ⑥ CM6 视图**只建一处**，且扩展清单就是 §5.1 那一份 ────────────────────
  const views = countOf(s.js, 'new CM6.EditorView(');
  if (views !== 1) bad.push('`new CM6.EditorView(` 出现 ' + views + ' 次（就地编辑只许建一处视图）');
  const viewBody = sliceAfter(s.js, 'function makeLiveView(', 3000);
  if (!viewBody) bad.push('main.js 找不到 makeLiveView');
  else {
    [
      ['CM6.EditorView.lineWrapping', '软换行（关掉它块高必然对不上）'],
      // ⭐ `design/0052` U3：⛔ 不能退化成 `CM6.markdown()`——默认 base 是 **commonmark**
      //    （无 GFM）⇒ `~~删~~` 根本不是 `Strikethrough` ⇒ 删除线标记永远藏不掉。
      ['CM6.markdown({ base: CM6.markdownLanguage })', 'Markdown 语法（GFM 方言 ＋ 装饰层的前提）'],
      ['LMarks.createField(', '藏标记的装饰层'],
      ['CM6.EditorView.updateListener.of(', '文档/选区变化的通知'],
      ['CM6.EditorView.editable.of(false)', 'contentDOM 不可编辑（INV-LIVE-12：浏览器写不进一个字节）'],
      ["contentAttributes.of({ tabindex: '-1'", 'contentDOM 不可聚焦'],
    ].forEach(function (pair) {
      if (viewBody.indexOf(pair[0]) < 0) bad.push('makeLiveView 少了 ' + pair[0] + ' —— ' + pair[1]);
    });
  }
  // ⛔ 这些一进来就会自带键位/历史，"谁处理哪个键"立刻变成两份事实。
  ['historyKeymap', 'defaultKeymap', 'standardKeymap', 'basicSetup', 'drawSelection'].forEach(function (n) {
    if (new RegExp('\\b' + n + '\\b').test(s.js)) bad.push('main.js 里出现了 ' + n + '（§5.1 白名单之外）');
  });

  // ── ⑦ 输入只从离屏 textarea 来，九条监听一条不少 ────────────────────────
  if (s.js.indexOf("input.className = 'cm-rmd-input'") < 0) bad.push('离屏输入源不叫 .cm-rmd-input');
  ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend',
    'copy', 'cut', 'paste'].forEach(function (ev) {
    if (s.js.indexOf("input.addEventListener('" + ev + "'") < 0) {
      bad.push('离屏 textarea 少挂 ' + ev + '（那类输入会静默丢失）');
    }
  });
  // ⚠️ 组合期**不改文档**这一条由 `live-input` 的纯逻辑判据守；这里守"接线还在"。
  if (s.js.indexOf("machine.handle({ type: 'compositionupdate'") < 0) {
    bad.push('compositionupdate 没有进状态机（preedit 与文档会脱节）');
  }

  // ── ⑧ 串行链的链尾必须吞拒绝（否则一次失败之后整条链永久 rejected）────────
  if (!/liveChain = run\.then\(function \(\) \{\}, function \(\) \{\}\);/.test(s.js)) {
    bad.push('liveSerial 的链尾没有吞拒绝 —— 一次失败会让后续每一次动作静默不执行');
  }

  // ── ⑧b 状态条的**错误等级由调用点给**（评审第 19 条）────────────────────
  //    ⚠️ 以前 `main.js` 按文案首字是不是 `⛔` 推断电平 ⇒ 改一个译文字就改掉界面语义。
  //    现在 `live/index.js` 只许经 `fail()` / `note()` 两个出口报告。
  {
    const bare = countOf(s.liveSrc, 'report(');
    if (bare !== 2) {
      bad.push('live/index.js 里 `report(` 出现 ' + bare + ' 次（应恰好 2 次：`fail` / `note` 的定义）');
    }
    if (s.liveSrc.indexOf("setStatus(s, s.slice(0, 1) === '⛔')") >= 0 || s.js.indexOf("s.slice(0, 1) === '⛔'") >= 0) {
      bad.push('仍有一处按文案首字 `⛔` 推断错误等级');
    }
  }

  // ── ⑨ 块级闸门的两个阈值 ─────────────────────────────────────────────
  if (!/maxBlockLines:\s*2000/.test(s.js) || !/maxBlockBytes:\s*256 \* 1024/.test(s.js)) {
    bad.push('LIVE_LIMITS 不是 §0.4 定的 2000 行 / 256 KiB');
  }
  // ⚠️ **两处必须相等**（评审第 16 条）：`main.js::LIVE_LIMITS` 经 `d.limits` 注入，
  //    `live/index.js::LIMITS` 是 `d.limits` 缺失时的 fallback。只钉一处的话，
  //    调上限时另一处会**静默漂移**，而所有闸门照样全绿。
  {
    const injected = s.js.match(/maxBlockLines:\s*(\d+),\s*maxBlockBytes:\s*(\d+)\s*\*\s*(\d+)/);
    const fallback = s.liveSrc.match(/maxBlockLines:\s*(\d+),\s*maxBlockBytes:\s*(\d+)\s*\*\s*(\d+)/);
    if (!injected) bad.push('main.js 里取不到 LIVE_LIMITS 的两个数');
    else if (!fallback) bad.push('live/index.js 里取不到 LIMITS 的两个数（fallback 改了写法？）');
    else {
      const a = [Number(injected[1]), Number(injected[2]) * Number(injected[3])];
      const b = [Number(fallback[1]), Number(fallback[2]) * Number(fallback[3])];
      if (a[0] !== b[0] || a[1] !== b[1]) {
        bad.push('LIVE_LIMITS 与 live/index.js 的 LIMITS 不一致（' + a.join('/') + ' vs ' + b.join('/') + '）');
      }
    }
  }

  // ── ⑩ 结构块⛔ 不进覆盖层，但要给一条可执行的路 ──────────────────────────
  const structBody = sliceAfter(s.js, 'function onLiveDocDown(', 2500);
  if (!structBody) bad.push('main.js 找不到 onLiveDocDown');
  else {
    if (structBody.indexOf('block.editable !== true') < 0) bad.push('onLiveDocDown 不判 block.editable');
    if (/editable !== true[\s\S]{0,220}?live\.begin\(/.test(structBody)) {
      bad.push('结构块也走了 live.begin（表格/代码块/公式会进覆盖层）');
    }
    if (structBody.indexOf("classList.contains('cm-rmd-liveHost')") < 0) {
      bad.push('onLiveDocDown 不跳过正在编辑的那一块（点它会被当成"点另一块"）');
    }
  }
  const downHooks = countOf(s.js, "addEventListener('mousedown', onLiveDocDown)");
  if (downHooks !== 1) bad.push('文档级 mousedown 委托出现 ' + downHooks + ' 次（应恰好 1 次）');

  // ── ⑪ 字典：live 用到的每一个键**两本**都得有（少了屏幕上就是键名）────────
  const keys = {};
  ((String(s.js) + '\n' + String(s.liveSrc || '')).match(/'(status\.live-[a-z-]+|status\.cell-[a-z-]+|status\.task-[a-z-]+|live\.[a-z-]+)'/g) || [])
    .forEach(function (q) {
      keys[q.slice(1, -1)] = true;
    });
  const missing = [];
  Object.keys(keys).sort().forEach(function (k) {
    ['zh', 'en'].forEach(function (lang) {
      const v = s.dict && s.dict[lang] ? s.dict[lang][k] : undefined;
      if (typeof v !== 'string' || v.length === 0) missing.push(lang + ' 少了 ' + k);
    });
  });
  if (missing.length) bad.push('字典缺键：' + missing.join('、'));
  if (Object.keys(keys).length < 10) bad.push('live 的字典键只扫到 ' + Object.keys(keys).length + ' 个，正则写错了？');

  // ── ⑫ 盒子的搬运（⚠️ 漏了它，几何判据仍然全绿，用户却看得见跳动/左跳）──────────
  //    `.doc p` 带 `margin-bottom: --reader-gap-block`（14px 下 15.4px）、列表带 `padding-left`、
  //    引用块带内边距与左边框、代码块带底色——而 host 是 `div`，`.doc` 那些**按标签写的**
  //    规则一条都不匹配；等高校验量的是 **border box**（**不含**外边距、**不含**横向）
  //    ⇒ 少了这一步不会被任何行为判据发现。
  const swapBody = sliceAfter(s.js, 'function swapLiveView(', 2600);
  if (!swapBody) bad.push('main.js 找不到 swapLiveView');
  else {
    if (swapBody.indexOf('LBox.applyBox(host, el)') < 0) {
      bad.push('swapLiveView 没搬被换掉那一块的盒子 —— 换进去之后正文会整体上跳/左跳');
    }
    if (swapBody.indexOf("host.className = 'cm-rmd-liveHost' + kindCls") < 0) {
      bad.push('swapLiveView 没重贴品种类 —— reseat 之后（块可能已经变成列表/代码块）样式停在旧那一种');
    }
    // ⚠️ **顺序是判据的一部分**：节点一旦脱树，`getComputedStyle` 的所有长属性都返回空串
    //    ⇒ 先 removeChild 再量，等于搬过去一堆空串，**静默无效果**（与没写这段代码等价）。
    const applyAt = swapBody.indexOf('LBox.applyBox(host, el)');
    const detachAt = swapBody.indexOf('parent.removeChild(el)');
    if (applyAt >= 0 && detachAt >= 0 && applyAt > detachAt) {
      bad.push('swapLiveView 先摘节点后量盒子 —— 脱树之后量到的是空串（静默无效）');
    }
  }
  const makeBody = sliceAfter(s.js, 'function makeLiveView(', 4200);
  if (!makeBody) bad.push('main.js 找不到 makeLiveView');
  else {
    if (makeBody.indexOf('LBox.applyBox(host, el)') < 0) {
      bad.push('makeLiveView 没搬盒子 —— 离屏量出来的高度不含内边距，引用块/代码块会被等高校验永久挡住');
    }
    if (makeBody.indexOf('LBox.classNameOf(el)') < 0) bad.push('makeLiveView 不认品种类（代码块的三样样式就套不上）');
    // ⭐ `bugs/0015`：标题块里的非标题行必须回落成正文尺度 ⇒ 装饰层要知道"块基线是不是标题"。
    //    ⚠️ 漏了这一条的**表现是纯视觉的**：回车之后新行还是 28px/700，
    //    而 `markers()` / `createField` 的纯逻辑判据照样全绿（它们只回答"该给哪些行贴类"，
    //    ⛔ 不回答"产品到底传没传 `bodyLines`"）。
    if (makeBody.indexOf('bodyLines:') < 0) {
      bad.push('makeLiveView 没把 `bodyLines` 交给装饰层 —— 标题块里回车出来的新行仍然是标题尺度（bugs/0015）');
    }
    if (makeBody.indexOf('LBox.headingLevelOf(el)') < 0) {
      bad.push('`bodyLines` 不是从 `LBox.headingLevelOf(el)` 派生的 —— 判"这一块原来是标题"的必须是标签名');
    }
    // §4.4：代码块**不装**软换行（长行横滚，⛔ 不让它折断缩进结构）。
    // ⭐ `design/0049`：**单元格同样不装**——GFM 的格子天然单行，一换行整张表就长高
    //    （`INV-CELL-04` 的布局冻结救不了行数变化）。
    if (!/if\s*\(!code\b[^)\n]*\)[^\n]*\.push\(CM6\.EditorView\.lineWrapping\)/.test(makeBody)) {
      bad.push('代码块 / 单元格也装了 EditorView.lineWrapping —— 长行会被折断（§4.4 / INV-CELL-04）');
    }
  }

  // ── ⑬ 退出覆盖层的**每一条路**都得接上（`bugs/0018` / 2026-10-27 用户实测）────
  //    「一旦进入标签模式，就出不来」有两个独立的成因，两个都只能在这一层看出来：
  //    ① `⌘↵` 写在裸 `Enter` 之后 ⇒ **永远到不了**（`⌘↵` 的 `key` 就是 `'Enter'`）；
  //    ② 覆盖层的键盘全挂在离屏 textarea 上 ⇒ 焦点一旦不在它身上，`Esc` 一个字节都收不到，
  //       界面上就**没有任何一条退路**了。
  const keyBody = sliceAfter(s.js, 'function onKeyDown(ev)', 6000);
  if (!keyBody) bad.push('main.js 找不到 onKeyDown');
  else {
    const modEnterAt = keyBody.indexOf('mods.cmd && (ev.key === \'Enter\'');
    const enterAt = keyBody.indexOf("if (ev.key === 'Enter')");
    if (modEnterAt < 0) bad.push('onKeyDown 没有 `⌘↵` 分支 —— 按了没有任何反应');
    else if (enterAt >= 0 && modEnterAt > enterAt) {
      bad.push('`⌘↵` 排在裸 `Enter` 之后 —— 它的第一个条件就是 key === "Enter"，永远到不了');
    }
    if (keyBody.indexOf("if (ev.key === 'Escape')") < 0) bad.push('onKeyDown 没有 `Esc` 分支');
  }
  const globalKeyHook = countOf(s.js, "addEventListener('keydown', onLiveGlobalKey, true)");
  if (globalKeyHook !== 1) {
    bad.push('document 级键盘兜底 `onLiveGlobalKey` 出现 ' + globalKeyHook + ' 次（应恰好 1 次，且必须是捕获期）');
  }
  const globalBody = sliceAfter(s.js, 'function onLiveGlobalKey(', 1600);
  if (!globalBody) bad.push('main.js 找不到 onLiveGlobalKey');
  else {
    // ⚠️ 缺这一条会**双重处理**：输入框自己那条路已经会退出，兜底再退出一次。
    if (globalBody.indexOf("classList.contains('cm-rmd-input')") < 0) {
      bad.push('onLiveGlobalKey 不跳过离屏 textarea —— 同一次按键会被处理两遍');
    }
    // ⚠️ 缺这一条会抢掉查找框 / 快速打开 / 设置里自己的 `Esc`。
    if (globalBody.indexOf('document.activeElement') < 0) {
      bad.push('onLiveGlobalKey 不判"焦点落在有用的地方没有" —— 会抢掉覆盖层自己的 Esc');
    }
  }
  // ⭐ 点了但**没进得去**必须等于退出：四类落空（点空白 / 块间隙 / 不在对齐表 / 结构块）原来全是裸 return。
  //    ⚠️ 判**调用点**（带引号的 `leaveAway('`），⛔ 别判 `leaveAway(`——那会连函数声明一起算进去，
  //    把"一个调用点都没有"判成绿的（M12 就是这么抓出来的）。
  if (structBody) {
    if (structBody.indexOf('function leaveAway(') < 0) {
      bad.push('onLiveDocDown 没有"点了但进不去 ⇒ 提交并退出"的那条路');
    }
    const leaveCalls = (structBody.match(/leaveAway\('/g) || []).length;
    if (leaveCalls < 3) {
      bad.push('onLiveDocDown 的落空分支只有 ' + leaveCalls + ' 处退出（点哪儿都没反应，用户只能重启应用）');
    }
    if (structBody.indexOf('live.isEditing()') < 0) {
      bad.push('onLiveDocDown 退出前不判 isEditing —— 阅读态点一下也会去动控制器');
    }
  }

  // ── ⑭ 表格单元格（`design/0049`）—— 另一条入口，接线错一位同样是静默的 ─────────
  //    为什么必须在这一层守：单元格那条路要同时接上**四个**位置（脚本顺序、控制器里的
  //    `wantCell` 分支、`main.js` 的点击路由、`swap`/`reseat` 的单元格形态），
  //    少任何一个的表现都是「点格子没反应」或「改了别的格子」，而 `live-cell.test.js`
  //    那 13 条纯逻辑判据**一条都碰不到接线**（它只验下标换算与写回拼接）。
  const liveSrc = String(s.liveSrc || '');
  if (liveSrc.indexOf("cell: require('./cell.js')") < 0) {
    bad.push('live/index.js 的加载器没把 cell.js 装进 LIVE（undefined ⇒ 点格子静默失效）');
  }
  if (s.js.indexOf('window.rmd.liveCell') < 0) bad.push('main.js 加载期没有取 window.rmd.liveCell');
  if (s.js.indexOf('cellNodeOf:') < 0) {
    bad.push('setupLive 的依赖里没有 cellNodeOf —— 切换目标后控制器找不回那一格（`leave()` 会整篇重渲）');
  }
  if (liveSrc.indexOf('fromCellPayload') < 0) bad.push('live/blocks.js 不解包 `table_cells`');
  if (liveSrc.indexOf('function commitCell(') < 0) {
    bad.push('live/index.js 没有 commitCell —— 单元格提交仍会走整块提交（会写坏同排其余格子）');
  } else {
    const cellBody = sliceAfter(liveSrc, 'function commitCell(', 2200);
    if (cellBody.indexOf('cellMod.splice(') < 0) {
      bad.push('commitCell 不用 cell.js::splice —— 两侧填充会被重拼掉（INV-CELL-01）');
    }
    if (cellBody.indexOf('cellMod.encode(') < 0) {
      // ⚠️ `2026-10-28`（`bugs/0035`）起 `encode` 不再"折换行"，而是把它写成 `<br>`：
      //    判据仍然是"提交必须过 `encode`"，只是**失效形态**换了 ——
      //    `|` 不转义会把表格撑坏，换行不写 `<br>` 会在写盘那一步**静默丢掉**用户刚敲的那一行。
      bad.push('commitCell 没过 `cell.js::encode` —— `|` 不转义会撑坏表格，'
        + '换行不写成 `<br>` 会静默丢行（INV-CELL-02）');
    }
    // ⭐ 提交区间必须**恰好一行**：这是"撤销栈 / 身份复核 / mount 全都不用改"的全部理由。
    //    ⚠️ `design/0054` 起这一段从"直接 `session.commit`"变成"交给 `publish()` 的 `range`"，
    //    判据跟着改口径（⛔ 别删——它守的是同一件事：**别拿整块区间去写一格**）。
    if (!/range:\s*\{\s*from:\s*from,\s*to:\s*from \+ 1\s*\}/.test(cellBody)) {
      bad.push('commitCell 的提交区间不是"一行换一行" —— 整块提交会连同同排格子一起重写');
    }
  }
  const swapCellBody = sliceAfter(s.js, 'function swapLiveCell(', 1600);
  if (!swapCellBody) bad.push('main.js 没有 swapLiveCell');
  else {
    // ⚠️ 不能换掉 `<td>` 本身（那是表格网格）：只能把它的**孩子**移走再挂 host。
    if (swapCellBody.indexOf('removeChild') < 0) {
      bad.push('swapLiveCell 不移走格子的孩子 —— 原文与视图会叠在一起');
    }
  }
  const reseatBody = sliceAfter(s.js, 'function reseatLive(', 2600);
  if (!reseatBody) bad.push('main.js 找不到 reseatLive');
  else if (reseatBody.indexOf('live.activeCell()') < 0) {
    bad.push('reseatLive 不认单元格 —— 重渲之后会把一个 `<td>` 当块换掉（网格塌掉）');
  }
  const navBody = sliceAfter(s.js, 'function navigateCell(', 1600);
  if (!navBody) bad.push('main.js 没有 navigateCell（Tab / Enter 走格）');
  else if (navBody.indexOf('flatAfter') < 0) {
    bad.push('navigateCell 不用 cell.js 的 flatAfter —— 走格会自己算一套下标');
  } else if (navBody.indexOf('leaveLive(') < 0) {
    bad.push('navigateCell 走到端点不退出 —— 最后一格按 Tab 会卡住（没有任何反馈）');
  }
  // ⚠️ **`flatBelow` 只在有策略声明 `enter: 'walk'` 时才要求**（评审第 18 条 ③）。
  //    旧判据无条件要求它 ⇒ 那半条**不可达**的代码被一条测试钉在原地，
  //    想清理的人先得改测试。现在反过来：没有对象声明 `'walk'` 时，它在不在都行；
  //    一旦真有对象这么声明，这条路**必须**接上 `cell.js` 的下标函数（⛔ 自己算一套）。
  {
    const anyWalk = /enter:\s*\/\*\* @type \{const\} \*\/ \('walk'\)/.test(OBJECTS);
    if (anyWalk && navBody.indexOf('flatBelow') < 0) {
      bad.push('有策略声明了 `enter: \'walk\'`，但 navigateCell 不用 cell.js 的 flatBelow');
    }
  }
  // ⭐ **每个对象都要把契约**（`design/0054` §2.1 的六个字段）**表全**（评审第 18 条 ①）：
  //    两张表里 `text` / `enter` 如今取值相同是**事实**，⛔ 不是冗余——它们是逐对象的
  //    声明面（将来加一个对象时，"它答了没有"必须看得见）。所以判据钉的是"都表了态"。
  {
    const fields = ['id', 'inlineOnly', 'box', 'tab', 'enter', 'text', 'verify'];
    const objs = ['BLOCK', 'CELL'];
    objs.forEach(function (name) {
      const at = OBJECTS.indexOf('const ' + name + ' = Object.freeze({');
      if (at < 0) {
        bad.push('live/objects.js 少了 ' + name);
        return;
      }
      const body = OBJECTS.slice(at, at + 1400);
      fields.forEach(function (f) {
        if (!new RegExp('(^|[\\s{])' + f + ':').test(body)) {
          bad.push(name + ' 没有声明 ' + f + '（契约表要求每个对象逐个表态）');
        }
      });
    });
  }
  // ⭐ 2026-10-29 代码评审第 15 条：「量 → 写 → 还」那套几何判据搬进 `cell.js`（有单测、
  //   进 `make typecheck`），`main.js` 只剩接线。⚠️ 判据跟着结构走，**两处都要在**——
  //   缺实现 = 表格跳；缺调用 = 冻结从没发生，两者都是静默的。
  if (s.cellSrc.indexOf('function freezeTableLayout(') < 0) {
    bad.push('live/cell.js 没有 freezeTableLayout 的实现 —— 那套几何判据又回到没有断言的地方了');
  }
  if (!/const thaw = isCell && LCell \? LCell\.freezeTableLayout\(el\) : null/.test(s.js)) {
    bad.push('main.js 没在 `isCell` 时调 `LCell.freezeTableLayout` —— 换格子时列宽会重算，整张表跳一下（INV-CELL-04）');
  }
  if (/(^|\n)\s*function freezeTableLayout\(/.test(s.js)) {
    bad.push('main.js 里又长出一份 freezeTableLayout —— 同一件事两份事实，其中一份 node 够不到');
  }
  if (s.js.indexOf('if (thaw)') < 0) {
    bad.push('freezeTableLayout 的还原函数没人调 —— 退出后表格的列宽永久被钉死');
  }
  // ⭐ 点击路由：表格分支必须在 `live.begin` 的**前面**，而且数量不符时**拒绝**（INV-CELL-06）。
  if (!structBody) {
    // 上面 ⑩ 已经报过缺 onLiveDocDown
  } else {
    const tableAt = structBody.indexOf("block.kind === 'Table'");
    if (tableAt < 0) {
      bad.push('onLiveDocDown 没有表格分支 —— 点格子走的是"结构块不能改"那条路');
    } else {
      const tableBody = structBody.slice(tableAt, tableAt + 1600);
      if (tableBody.indexOf('cell: { flat: flat }') < 0) {
        bad.push('onLiveDocDown 进入单元格时不带 `cell.flat` —— 控制器会按整块进入');
      }
      if (tableBody.indexOf('domCount !== spans.length') < 0) {
        bad.push('onLiveDocDown 不校验 DOM 格子数与载荷格子数 —— 错位一格会改到别的格子（INV-CELL-06）');
      }
      ['status.cell-pairing', 'status.cell-hint'].forEach(function (k) {
        if (tableBody.indexOf(k) < 0) bad.push('表格分支的拒绝不报 ' + k + '（§6：三条拒绝都要说出来）');
      });
    }
    // ⚠️ `Table` 块本身⛔ 仍然是结构块：表格分支**不许**把 `editable` 判据挪走。
    if (tableAt >= 0) {
      const editableAt = structBody.indexOf('block.editable !== true');
      if (editableAt >= 0 && editableAt < tableAt) {
        bad.push('表格分支排在 `editable !== true` 之后 —— 结构块那条路先返回，点格子永远到不了');
      }
    }
  }

  // ── ⑮ 任务项打勾（`design/0051`）—— 同样是"接线错一位就静默"的一条路 ───────────
  //    为什么必须在这一层守：打勾要同时接上**六个**位置（脚本顺序、加载器、`main.js` 的武装
  //    与点击、`onLiveDocDown` 的提前返回、载荷解包、同长度替换）。少任何一个的表现都是
  //    "点方框什么都不发生"或"点了却改到别处"，而 `live-task.test.js` 那几条纯逻辑判据
  //    **一条都碰不到接线**。
  if (liveSrc.indexOf("task: require('./task.js')") < 0) {
    bad.push('live/index.js 的加载器没把 task.js 装进 LIVE（undefined ⇒ 点方框静默失效）');
  }
  if (s.js.indexOf('window.rmd.liveTask') < 0) bad.push('main.js 加载期没有取 window.rmd.liveTask');
  if (liveSrc.indexOf('fromTaskPayload') < 0) bad.push('live/blocks.js 不解包 `task_items`');
  // ⭐ 2026-10-29 代码评审第 15 条：**武装本体**搬进 `live/task.js`（`make typecheck` 查得到、
  //    `live-task.test.js` 用假节点跑得到），`main.js` 只剩接线。⚠️ 判据跟着结构走，两处都要在。
  const armBody = sliceAfter(s.taskSrc, 'function arm(', 1400);
  if (!armBody) {
    bad.push('live/task.js 没有 arm（方框仍是 disabled ⇒ WebKit 根本不派发 click）');
  } else {
    ['removeAttribute', 'disabled', 'tabIndex'].forEach(function (needle) {
      if (armBody.indexOf(needle) < 0) {
        bad.push('live/task.js 的 arm 少了 `' + needle + '` —— 方框收不到点击，症状是"点了没反应"');
      }
    });
  }
  const armWiring = sliceAfter(s.js, 'function armTaskBoxes(', 500);
  if (!armWiring) {
    bad.push('main.js 没有 armTaskBoxes（方框仍是 disabled ⇒ WebKit 根本不派发 click）');
  } else {
    if (!/LTask\.arm\(doc, \{/.test(armWiring)) {
      bad.push('armTaskBoxes 没交给 `live/task.js::arm` —— 判据又回到没有任何断言的那一层');
    }
    ['onTaskBoxDown', 'onTaskBoxClick'].forEach(function (needle) {
      if (armWiring.indexOf(needle) < 0) {
        bad.push('armTaskBoxes 没把 `' + needle + '` 传下去 —— 方框收不到点击，症状是"点了没反应"');
      }
    });
  }
  // ⚠️ 武装必须挂在 `noteLive` 里（对齐之后）：每次重渲 DOM 都是新的一批 `disabled` 方框。
  const noteBody = sliceAfter(s.js, 'function noteLive(', 900);
  if (noteBody.indexOf('armTaskBoxes()') < 0) {
    bad.push('noteLive 不武装任务项方框 —— 打勾一次之后新的方框又回到 disabled，之后再也点不动');
  }
  const taskClickBody = sliceAfter(s.js, 'function onTaskBoxClick(', 1800);
  if (!taskClickBody) {
    bad.push('main.js 没有 onTaskBoxClick');
  } else {
    if (taskClickBody.indexOf('preventDefault') < 0) {
      bad.push('onTaskBoxClick 不 preventDefault —— 失败时方框会停在"已勾"的假象上（§6 末行）');
    }
    if (taskClickBody.indexOf('LTask.countOf(') < 0 || taskClickBody.indexOf('domChecked') < 0) {
      bad.push('onTaskBoxClick 不把 DOM 的方框数与勾选状态交给控制器 —— `INV-TASK-03` 的配对判据没有输入');
    }
    if (taskClickBody.indexOf('live.toggleTask(') < 0) {
      bad.push('onTaskBoxClick 不走 live.toggleTask —— 打勾会绕过唯一提交链');
    }
    if (taskClickBody.indexOf('status.task-pairing') < 0) {
      bad.push('任务项的对不上不报 status.task-pairing（§6：三条拒绝都要说出来）');
    }
  }
  // ⚠️ `onLiveDocDown` 必须在**任何 `leaveAway`** 之前提前返回：否则点一下方框会先退出当前
  //    编辑态、再走一遍"进入这一块"——用户看到的是编辑器闪一下、勾却没变。
  const taskEarlyAt = structBody ? structBody.indexOf('LTask.isTaskCheckbox(ev.target)') : -1;
  if (structBody && taskEarlyAt < 0) {
    bad.push('onLiveDocDown 不认任务项方框 —— 点方框会走"进入这一块"那条路');
  } else if (taskEarlyAt >= 0) {
    const awayAt = structBody.indexOf('leaveAway(');
    if (awayAt >= 0 && awayAt < taskEarlyAt) {
      bad.push('任务项的提前返回排在 leaveAway 之后 —— 点一下方框会先退出当前编辑态');
    }
  }
  // ⭐ 控制器：同长度替换 ＋ 一行换一行 ＋ 进入前的脏快照（`INV-TASK-01/04/06`）。
  if (liveSrc.indexOf('function doToggleTask(') < 0) {
    bad.push('live/index.js 没有 doToggleTask');
  } else {
    const tBody = sliceAfter(liveSrc, 'function doToggleTask(', 5200);
    if (tBody.indexOf('taskMod.toggleLine(') < 0) {
      bad.push('doToggleTask 不用 task.js::toggleLine —— 整行重写会丢掉行尾与两侧内容的原样');
    }
    if (!/session\.commit\(\s*\{\s*from:\s*idx,\s*to:\s*idx \+ 1\s*\}/.test(tBody)) {
      bad.push('doToggleTask 的提交区间不是"一行换一行"（`INV-TASK-01`）');
    }
    const snapAt = tBody.indexOf('const wasDirty = dirty();');
    const commitAt = tBody.indexOf('const res = session.commit(');
    if (snapAt < 0) {
      bad.push('doToggleTask 不取进入前的脏快照 —— 打勾会替用户偷偷保存别的改动（`INV-TASK-06`）');
    } else if (commitAt >= 0 && snapAt > commitAt) {
      bad.push('wasDirty 在提交之后才取 —— 那时一定为真，打勾永远不写盘');
    }
  }

  // ── ⑧ `INV-KERNEL-05`：块永远进得去 ＋ U6 的锚定接线（`design/0052`）─────────
  // 为什么必须是源码级的：产品**拒收**一块时，`probe-live-block` 的 B 段只产生
  // "等不到宿主"那一条，其余几条**根本不会出现**（它只在"进得去之后"才量几何）
  // ⇒ "探针全绿"与"用户点不进去"可以同时成立（`docs/bugs/0025` 就是这么活下来的）。
  // ⚠️ `s.liveSrc` 是**原样拼接**的（没剥注释）⇒ 这里自己剥一遍，⛔ 别让注释里的旧口径把人骗红。
  const liveCode = stripLineComments(stripBlockComments(String(s.liveSrc || '')));
  if (liveCode.indexOf("why: 'geometry'") >= 0 || liveCode.indexOf('why: "geometry"') >= 0) {
    bad.push('`src/live/**` 里还有按几何**拒收**整块的出口（`INV-KERNEL-05`：块永远进得去，'
      + '几何差只许告警、只许补滚动）');
  }
  if (liveCode.indexOf("t('status.live-short'") < 0) {
    bad.push('`src/live/**` 不再报「这一块进来之后比原来矮」——变矮意味着字号/行高/内边距搬丢了，'
      + '而它在屏幕上不报错，状态条是用户唯一看得见的那一处');
  }

  // ⚠️ 允许量**不许回到 `main.js`**：`bugs/0025` 的病根是"同一个算式有两份"。
  //    U6 之后产品**没有**允许量（拒收已删）⇒ 这里守的是"别把它偷偷加回来"。
  const mainCode = String(s.js || '');
  if (mainCode.indexOf('layoutSlack') >= 0) {
    bad.push('main.js 又出现 `layoutSlack` —— 允许量回到了产品侧，几何又会拦人'
      + '（`INV-KERNEL-05`：块永远进得去）');
  }

  // ⭐ U6 的锚定接线，三件事各有一个**顺序/落点**要求：
  const swapU6 = sliceAfter(mainCode, 'function swapLiveView(', 3000);
  if (!swapU6) bad.push('main.js 找不到 swapLiveView');
  else {
    const anchorCall = swapU6.indexOf('anchorAt(');
    const removeAt = swapU6.indexOf('removeChild(el)');
    const anchorYAt = swapU6.indexOf('anchorY =');
    if (anchorCall < 0) {
      bad.push('swapLiveView 没调 `view.anchorAt` —— 进入之后没有锚定，'
        + '点进去下面的内容会整体窜（`design/0052` U6）');
    } else if (removeAt >= 0 && anchorCall < removeAt) {
      bad.push('`anchorAt` 在换掉旧节点**之前**就调了 —— 那一刻量的还是旧几何，补出来的滚动量是错的'
        + '（顺序必须是：先量行顶 → 再 swap → 最后按新视图补）');
    }
    if (anchorYAt < 0) {
      bad.push('swapLiveView 不记被点那一行的**行顶**（`anchorY`）—— 没有锚点可补');
    } else if (removeAt >= 0 && anchorYAt > removeAt) {
      bad.push('`anchorY` 在 `removeChild(el)` **之后**才算 —— `el` 已脱树，'
        + '`getBoundingClientRect` / `getComputedStyle` 全成 0');
    }
  }
  const anchorBody = sliceAfter(mainCode, 'anchorAt: function (anchor)', 1200);
  [['readMeasured(', '逼 CM6 先同步量一次（`documentTop` 在离屏期是别处的值）'],
   ['光标行顶(', '按**渲染出来的那一行**量（行号会随装饰层变 ⇒ 用光标位置认行）'],
   ['scrollHostOf(', '找能滚的那个宿主（`#doc` 不一定是滚动容器）'],
   ['scrollTop +=', '补滚动'],
   ['innerHeight', '差超过一屏就放弃（"宁可不补，也不乱补"）']].forEach(function (pair) {
    if (anchorBody && anchorBody.indexOf(pair[0]) < 0) {
      bad.push('`anchorAt` 里少了 `' + pair[0] + '` —— ' + pair[1]);
    }
  });
  // ⚠️⚠️ `coordsAtPos` ⛔ **不许当首选**（2026-10-27 实测）：swap 那一帧 CM6 的高度表
  //    对这一块还是估算值，它给的行顶与渲染位置差 16 px 以上 ⇒ 必须先取 DOM 那一行，
  //    它只是"DOM 里找不到"时的兜底。顺序反了与"完全没修"**同形**（delta 被算成 0）。
  const 行顶函数 = sliceAfter(mainCode, 'function 光标行顶(view)', 900);
  if (!行顶函数) {
    bad.push('main.js 找不到 `光标行顶` —— 锚点"那一行在哪"没有唯一实现');
  } else {
    const domAt = 行顶函数.indexOf("closest('.cm-line')");
    const glyphAt = 行顶函数.indexOf('首字顶(');
    const coordsAt = 行顶函数.indexOf('coordsAtPos(');
    if (domAt < 0) bad.push('`光标行顶` 不找 DOM 里的 `.cm-line` —— 拿 CM6 的估算值当尺子');
    if (glyphAt < 0) bad.push('`光标行顶` 不取**首字字形顶** —— 与锚点基线不是同一把尺（`INV-KERNEL-07`）');
    if (coordsAt < 0) bad.push('`光标行顶` 连 `coordsAtPos` 兜底都没有 —— DOM 里找不到时直接放弃');
    else if (domAt >= 0 && coordsAt < domAt) {
      bad.push('`光标行顶` 先用 `coordsAtPos`、后看 DOM —— 顺序反了，swap 那一帧读到的是估算值');
    }
  }
  // ⚠️⚠️ 基线必须取**第一行文字的字形顶**：代码块的内边距住在内层 `code` 上，
  //    按 `el.top + el.paddingTop` 算会差 16.38 px（`design/0052` U10 的根因）。
  if (swapU6 && swapU6.indexOf('首行盒(') < 0) {
    bad.push('`swapLiveView` 不用 `首行盒` 量锚点基线 —— 代码块会差一个内边距（16.38 px）');
  }

  // ⭐ 探针那半：判据必须跟着口径走，⛔ 别留"变高有上界"那一套（U6 之后没有上界）。
  const harnessSrc = String(s.harness || '');
  if (countOf(harnessSrc, '上界 =') > 0) {
    bad.push('探针里还有 `上界 =` —— B 段/G5 的判据必须换成**锚点位移**（`design/0052` U6）');
  }
  if (harnessSrc.indexOf('-3b F5 锚点不位移') < 0) {
    bad.push('探针的 B-3b 不再判**锚点位移** —— 那是 U6 之后"我点的那一行会不会跑"的唯一自动防线');
  }
  if (harnessSrc.indexOf('host.querySelector(\'.cm-line\')') < 0) {
    bad.push('探针的锚点判据没取**渲染出来的那一行**（`host.querySelector(\'.cm-line\')`）—— '
      + '量的不是用户看到的那一行');
  }
  // ⚠️⚠️ 光有 B-3b 不够：盒子搬对之后大多数块本来就不动（整轮 96 条 `滚动差 0 px`）
  //    ⇒ 产品的 `scrollTop += delta` 那一支**一次都执行不到**，锚定整条坏掉照样全绿。
  //    ⇒ 探针必须有一段**故障注入**的对照，真的把"那一行挪 40 px"逼出来。
  if (harnessSrc.indexOf('X1 注入 40 px') < 0 || harnessSrc.indexOf('__rmd_probe_shift') < 0) {
    bad.push('探针没有锚定的**故障注入对照**（X 段）—— B-3b 在"块本来就不动"时对整条锚定结构性失明');
  }

  // ── ⑯ `⌘↵` = **跳出当前块、在后头新起一段**（`bugs/0024`，2026-10-28 用户更正）─────
  //    为什么必须在这一层守：这条交互要同时接上**四处**——块内 keydown、document 级兜底、
  //    控制器里的 `newParagraph()` / `undoNewParagraph()`、以及依赖里的 `pendingHost`。
  //    少任何一处，表现都是**静默的**：按了要么退出到阅读态（旧需求）、要么什么都不发生。
  if (s.js.indexOf('function startNewParagraph(') < 0) {
    bad.push('main.js 没有 startNewParagraph —— `⌘↵` 没有"新起一段"这条入口');
  } else {
    const startBody = sliceAfter(s.js, 'function startNewParagraph(', 400);
    if (startBody.indexOf('live.newParagraph()') < 0) {
      bad.push('startNewParagraph 没调 live.newParagraph() —— `⌘↵` 仍是"退出到阅读态"');
    }
  }
  if (s.js.indexOf('pendingHost: pendingHost') < 0) {
    bad.push('setupLive 的依赖里没有 pendingHost —— 控制器造不出"新那一段"的宿主（`⌘↵` 静默无效）');
  }
  if (liveSrc.indexOf('async function newParagraph(') < 0) {
    bad.push('live/index.js 没有 newParagraph —— 控制器那条路不存在');
  } else {
    const npBody = sliceAfter(liveSrc, 'async function newParagraph(', 3000);
    // ⚠️⚠️ **必须插三行**：comrak 把相邻非空行并进同一段 ⇒ 只插一行时用户敲的第一个字
    //    会跟上面那一块或下面的正文**合并**（屏幕上表现为"新写的字跑进了引用块里"）。
    if (!/\['[^']*',\s*'[^']*',\s*'[^']*'\]/.test(npBody)) {
      bad.push('newParagraph 插入的不是三行空行 —— 相邻非空行会被并进同一段，新写的字会跑进上一块');
    }
    if (npBody.indexOf("caretPos: 0") < 0) {
      bad.push('newParagraph 没把光标放到段首 —— 用户还得自己找光标（这正是 `bugs/0024` 要修的）');
    }
    if (npBody.indexOf('leave(') < 0) {
      bad.push('newParagraph 不走 leave() —— "先还宿主再提交"那条顺序（`bugs/0018` ④）会丢');
    }
  }
  if (liveSrc.indexOf('async function dropEmptyPending(') < 0) {
    bad.push('live/index.js 没有 dropEmptyPending —— 一个字没敲就退出会在用户文件里留三个空行');
  }
  if (liveSrc.indexOf('async function undoNewParagraph(') < 0) {
    bad.push('live/index.js 没有 undoNewParagraph —— 一次 ⌘Z 收不回"新起一段"这一步');
  }
  const undoFnBody = sliceAfter(s.js, 'function undoOnce()', 900);
  if (undoFnBody && undoFnBody.indexOf('live.isNewParagraph()') < 0) {
    bad.push('undoOnce 不认"新起的那一段" —— 在新段落里按 ⌘Z 什么都不发生');
  }
  // ⛔ 反向：**块内 keydown 与 document 级兜底都要接上**（`⌘↵` 有这两条入口，
  //    只接一处的话"焦点丢了"那一半仍然退回旧的"退出到阅读态"）。
  const npCalls =
    (s.js.match(/liveSerial\(function \(\) \{ return startNewParagraph\(\); \}\)/g) || []).length;
  if (npCalls < 2) {
    bad.push('`⌘↵` 只有 ' + npCalls + ' 处接到 startNewParagraph（块内 keydown 与 document 级兜底都要接）');
  }
  // ⚠️⚠️ `caret()` ⛔ **不许**绕道 `LSel.range(...)` 再取 `.head`（2026-10-28 探针实测踩过）：
  //    `range()` 归一化出来的是 `{from, to}`，**根本没有 `head`** ⇒ 读到 `undefined` ⇒
  //    `Number.isInteger` 一挡就退成 `caretPos: 0`，"一次 ⌘Z 恢复光标"静默变成"回到段首"。
  //    ⚠️ 这条缺陷**三层都看不见**：纯逻辑判据的假视图自己给整数、`W1` 的新段落光标本来就是 `0`
  //    （恢复成 0 也对）、而 `main.js` 不在 `make typecheck` 的范围里（`adr/0005` 不动）。
  //    ⇒ 只有源码级这一条守得住。
  const caretFn = sliceAfter(s.js, 'caret: function ()', 120);
  if (!caretFn) {
    bad.push('main.js 的编辑视图没有 `caret()` —— `⌘↵` 记不下"操作前那个光标"，撤销之后回不去');
  } else if (caretFn.indexOf('selection.main.head') < 0) {
    bad.push('`caret()` 不是读视图自己的选区 —— `LSel.range()` 给的是 `{from, to}`（没有 `head`），'
      + '取 `.head` 会得到 `undefined` ⇒ 撤销之后光标恒回段首（用户点名的第三条验收静默失守）');
  }

  // ── ⑰ **离屏标记必须在 swap 时摘掉**（`design/0049`，2026-10-28 用户实测）────────
  //    `.cm-rmd-liveHost.cm-rmd-offscreen` 是 `position: fixed; visibility: hidden;
  //    z-index: -1; pointer-events: none`（`live.css` §1b）——它是**量高期**的形态，⛔ 不是
  //    进文档流之后的形态。两条 swap 路径（块级 `swapLiveView` / 单元格 `swapLiveCell`）
  //    各自要摘一次：块级一直在摘（`host.className = 'cm-rmd-liveHost' + kindCls`），
  //    单元格那条**漏了** ⇒ 用户原话「对于表格数据，点击表格中的数据，数据会消失，
  //    无法选中，无法编辑」——那一格的文字整片不见、光标画在离屏层里、点击还穿到 `<td>` 上。
  //    ⚠️⚠️ 为什么探针 Q 段当时全绿：`Q1` 只判 `parentElement`（离屏宿主照样是 `<td>` 的孩子）、
  //    列宽被冻结 ⇒ `Q2` 绿、同一行别的格子撑着行高 ⇒ `Q2b` 绿、`Q3`–`Q5d` 读 `.cm-content`
  //    的文本（离屏视图里一字不差）⇒ 全绿。**"看不看得见"这一维当时没有任何判据量过。**
  //    ⇒ 同批在探针里补了 `Q1b`/`Q1c` 与变异 `M21`；这一条是**源码级**的第二道闸
  //    （探针要醒屏才跑得动，`make test-js` 随时跑得动）。
  const cellSwapBody = sliceAfter(s.js, 'function swapLiveCell(', 1200);
  if (!cellSwapBody) {
    bad.push('main.js 没有 swapLiveCell —— 表格单元格的交换路径不存在');
  } else if (!/host\.className\s*=\s*'[^']*cm-rmd-cell[^']*'/.test(cellSwapBody)) {
    bad.push('swapLiveCell 没有重写 host 的 className —— 那一格换进 `<td>` 之后仍带着 '
      + '`cm-rmd-offscreen`（`visibility: hidden`）⇒ 点一下格子里的字整片消失、选不中也改不了');
  } else if (/host\.className\s*=\s*'[^']*cm-rmd-offscreen[^']*'/.test(cellSwapBody)) {
    bad.push('swapLiveCell 把 `cm-rmd-offscreen` 写回去了 —— 换进文档流的那一格永远不可见');
  }

  // ── ⑱ **输入约束与呈现策略只有一处声明**（`design/0054` `INV-EDITOBJ-01/02`）──────
  //    收掉的那份"第二份事实"长这样：`main.js::onPaste` 里的一行
  //    `isCell ? text2.replace(/\r\n?|\n/g, ' ') : text2`。它看着是对的，但：
  //      ① 只管**粘贴**一个入口 —— IME 上屏（`compositionend`）与 `beforeinput` 插入都绕过去了；
  //      ② 与键分派里的"Enter/走格"、与 `main.js` 的 `cellContext: isCell` 各记一半
  //         ⇒ 同一件事散在**三处**，谁也不知道自己是第几份。
  //    ⇒ 现在：**声明**只在 `live/objects.js` 的策略表；**执行**在 `live/input.js` 的
  //      **每一个**文本入口（`textIn()`），`live/cell.js::encode` 退回"提交时的最后防线"。
  //
  //    ⚠️ 为什么必须在**源码级**守：跑错了**屏幕上不报错**——
  //       `encode` 会把提交结果折回来 ⇒ 只有"表格在粘贴/上屏那一刻跳一下"看得见；
  //       而那一条要醒屏才跑得动（探针 `Q14b`），`make test-js` 随时跑得动。
  const objSrc = String(s.objects || '');
  // ⭐⭐ **`bugs/0035`（2026-10-28 用户需求变更）**：格内换行**保留**。
  //    用户原话「表格编辑还是不能换行，enter 键无法换到下一行，直接到表格的下一行中了」
  //    ⇒ 视图里是 `\n`、源码里是 `<br>`（`cell.js::encode`/`decode` 一对逆变换）。
  //    ⇒ 策略表里⛔ 不许再有"把换行折成空格"的那条规则——它现在会让"回车换行"**静默变成空格**。
  if (objSrc.indexOf('foldNewlines') >= 0) {
    bad.push('`live/objects.js` 又把单元格的换行折掉了（`foldNewlines`）—— '
      + '`bugs/0035` 之后格内换行要原样进视图（存储形态是 `<br>`）');
  }
  const cellPolicy = sliceAfter(objSrc, 'const CELL = Object.freeze({', 400);
  if (!cellPolicy) bad.push('`live/objects.js` 里没有单元格那一份策略（`CELL`）');
  else if (sliceAfter(cellPolicy, 'enter:', 80).indexOf("'newline'") < 0) {
    bad.push('单元格的 `Enter` 不是换行（`enter: \'newline\'`）—— '
      + '用户明确要求格内回车换行（`bugs/0035`）');
  }
  const blockPolicy = sliceAfter(objSrc, 'const BLOCK = Object.freeze({', 400);
  if (!blockPolicy) bad.push('`live/objects.js` 里没有块级那一份策略（`BLOCK`）');
  else if (sliceAfter(blockPolicy, 'enter:', 80).indexOf("'newline'") < 0) {
    bad.push('块级对象的 `Enter` 不是换行 —— 正文里按回车不长行（`INV-LIVE-13`）');
  }
  if (objSrc.indexOf('function policyOf(') < 0) {
    bad.push('`live/objects.js` 没有 `policyOf()` —— 调用点只能自己 `if (cell)` 猜，等于没有表');
  }
  // ⭐ 换行往返的三个落点**缺一不可**（缺任何一个，"回车换行"都会在下一次点进来时露馅）：
  //    ① `cell.js::encode` 把 `\n` 写成 `<br>`；② `cell.js::decode` 把 `<br>` 还原成 `\n`；
  //    ③ `live/index.js` **进入**这一格时用 `decode`（⛔ 不是直接把源码塞进视图）。
  const cellSrc = String(s.cellSrc || '');
  // ⚠️ 窗口按**下一个函数**切，⛔ 不用固定长度：`encode` 的注释一长，固定 300 就会
  //    漏到函数外面——那时判据要么永远红，要么被**别的函数里的字符串**喂饱（同样是静默的）。
  const encAt = cellSrc.indexOf('function encode(text)');
  const encEnd = encAt < 0 ? -1 : cellSrc.indexOf('function decode(text)', encAt);
  const encBody = encAt < 0 ? '' : cellSrc.slice(encAt, encEnd < 0 ? cellSrc.length : encEnd);
  if (!encBody || encBody.indexOf("'<br>'") < 0) {
    bad.push('`live/cell.js::encode` 没把换行写成 `<br>` —— 提交出去的会是折成空格的一行（`bugs/0035`）');
  }
  if (!/function decode\(text\)/.test(cellSrc)) {
    bad.push('`live/cell.js` 没有 `decode()` —— 再次点进这一格会看到字面的四个字符 `<br>`');
  }
  const enterCellBody = sliceAfter(String(s.liveSrc || ''), 'const raw = cellMod.textOf(', 800);
  if (!enterCellBody || enterCellBody.indexOf('cellMod.decode(') < 0) {
    bad.push('`live/index.js` 进入单元格时没有 `cellMod.decode(...)` —— 源码里的 `<br>` 会原样显示在视图里');
  }
  // ⭐ 执行侧：状态机**每一个**文本入口都要过同一道约束。
  const liveSrcAll = String(s.liveSrc || '');
  if (liveSrcAll.indexOf('function createInputMachine(onTransaction, policy)') < 0) {
    bad.push('`live/input.js` 的 `createInputMachine` 不接策略 —— 输入机拿不到对象约束');
  }
  const textInBody = sliceAfter(liveSrcAll, 'function textIn(raw)', 400);
  if (!textInBody) bad.push('`live/input.js` 里没有 `textIn()`（入口约束的唯一执行点）');
  else {
    if (textInBody.indexOf('normalizeNewlines(') < 0) {
      bad.push('`textIn` 不做行尾归一化 —— CRLF 会原样进文档（`INV-LIVE-13`）');
    }
    if (textInBody.indexOf('policy.text') < 0) {
      bad.push('`textIn` 没读 `policy.text` —— 入口约束成了状态机自己的第二份实现');
    }
  }
  // 四个文本入口：`compositionend` / `beforeinput` 插入 / `input` / `paste`。
  // ⚠️ 计的是**调用点**（`textIn(` 一共 5 处：1 处定义 ＋ 4 处调用）；
  //    少一处 = 那条入口把对象的约束绕过去了，而屏幕上只有"表格跳一下"。
  const textInCalls = countOf(liveSrcAll, 'textIn(');
  if (textInCalls < 5) {
    bad.push('`live/input.js` 里 `textIn(` 只有 ' + textInCalls + ' 处（应为 1 处定义 ＋ 4 处调用）—— '
      + '有文本入口没过对象约束（IME 上屏 / `beforeinput` 插入 / `input` / `paste` 各一处）');
  }
  // ⚠️ 粘贴入口⛔ 不许再折一遍：那正是这次收掉的"第二份事实"。
  const pasteBody = sliceAfter(s.js, 'function onPaste(ev)', 800);
  if (!pasteBody) bad.push('main.js 找不到 onPaste —— 粘贴这条入口不存在');
  else if (pasteBody.indexOf('replace(') >= 0) {
    bad.push('`onPaste` 又折了一次换行 —— 同一条约束出现第二份事实（`INV-EDITOBJ-01`）');
  }
  // 接线层：四件事都读策略，⛔ 不许回到 `if (isCell)`。
  if (s.js.indexOf('const LObj = window.rmd.liveObjects') < 0) {
    bad.push('main.js 加载期没有取 `window.rmd.liveObjects` —— 策略表没人读，四条约束各判各的');
  }
  if (makeBody.indexOf('createInputMachine(onTransaction, obj)') < 0) {
    bad.push('`makeLiveView` 建状态机时没把策略交进去 —— 单元格的换行约束在入口就没了');
  }
  if (makeBody.indexOf('cellContext: obj.inlineOnly') < 0) {
    bad.push('`cellContext` 不是从策略推导的（`obj.inlineOnly`）—— 呈现模式又回到接线处临时判');
  }
  if (makeBody.indexOf('obj.box') < 0) {
    bad.push('盒子搬不搬不看策略（`obj.box`）—— 同一件事的第二份事实');
  }
  if (keyBody.indexOf("obj.tab === 'walk'") < 0 || keyBody.indexOf("obj.enter === 'walk'") < 0) {
    bad.push('`Tab` / `Enter` 的走格分支不看策略（`obj.tab` / `obj.enter`）—— '
      + '允许的操作又回到键处理里各判一半');
  }

  // ── ⑲ 组合串覆盖层的**排版跟光标那一行走**（2026-10-29 用户实测）──────────────
  //    用户原话：「在标题下面一行输入的时候，拼音落地的字体虽然是正文，正常，
  //    但是拼音的字很大。」根因：`.cm-rmd-preedit` 挂在 host 上，而 host 身上是
  //    `live/box.js` 搬来的**块级**文字层（标题块量出来就是标题尺度）⇒ 标题块第二行
  //    （`cm-rmd-line` 上的 `cm-rmd-body`，正文尺度）上，拼音按标题字号画、上屏却是正文。
  //    ⚠️ 纯 DOM 层的 `D3` 只判"覆盖层有文本"，字号错了照样绿；真机判据在
  //    `probe-live-block` 的 `N1b`/`N3b`（要醒屏才跑得动）⇒ 这一条是**源码级**的第二道闸。
  const preeditBody = sliceAfter(s.js, 'function paintPreedit(', 1200);
  if (!preeditBody) bad.push('main.js 找不到 paintPreedit —— 组合串覆盖层不存在');
  else if (preeditBody.indexOf('syncPreeditMetrics(preeditEl);') < 0) {
    bad.push('`paintPreedit` 没给组合串对齐**光标那一行**的排版 —— 标题块第二行的拼音会按标题字号画'
      + '（用户 2026-10-29 实测："拼音的字很大"）');
  }
  //    ⚠️ 量的那个基准住在 `caretLineEl()` 里（`syncPreeditMetrics` 只是调用它）——
  //       所以这两条**必须各查各的函数体**，⛔ 别用一个 900 字符窗口去跨两个函数查。
  const caretLineBody = sliceAfter(s.js, 'function caretLineEl(', 700);
  if (!caretLineBody) bad.push('main.js 找不到 caretLineEl —— 组合串的排版基准没有来源');
  else if (caretLineBody.indexOf('view.domAtPos(sel.head)') < 0) {
    bad.push('`caretLineEl` 不是从 `view.domAtPos(sel.head)` 取那一行的 —— '
      + '基准变成了 host（块级文字层），标题块里第二行的拼音会按标题尺度画');
  }
  const metricsBody = sliceAfter(s.js, 'function syncPreeditMetrics(', 900);
  if (!metricsBody) bad.push('main.js 找不到 syncPreeditMetrics —— 组合串的排版权重没有来源');
  else {
    if (metricsBody.indexOf('caretLineEl()') < 0) {
      bad.push('`syncPreeditMetrics` 不是从 `caretLineEl()` 量的 —— '
        + '基准变成了 host（块级文字层），标题块里第二行的拼音会按标题尺度画');
    }
    if (!/el\.style\.fontSize\s*=/.test(metricsBody) || !/el\.style\.fontWeight\s*=/.test(metricsBody)) {
      bad.push('`syncPreeditMetrics` 没有写 `font-size` / `font-weight` —— 覆盖层仍继承 host 的块级文字层');
    }
  }

  // ── ⭐ 鼠标拖选五条（`bugs/0042`–`0046`，2026-10-29）的**接线**那一半 ──────────
  //    这一族的失效形态全都不报错：第一次拖选整段丢失 / 词首双击多吞一个词 /
  //    跨软换行只画一条竖条。纯逻辑那半在 `tests/js/live-selection.test.js`。
  const sel = s.selSrc || '';

  if (countOf(s.js, 'noteDownGesture(ev);') < 2) {
    bad.push('`main.js` 里 `noteDownGesture(ev);` 少于 2 处 —— 两个 `live.begin` 入口（普通块 / 单元格）'
      + '都得记下这次按下，少一处 ⇒ 从那条路点进去的第一次拖选整段丢失（`bugs/0042`）');
  }
  const installCall = sliceAfter(s.js, 'installMouse(view, {', 500);
  if (!installCall) bad.push('`main.js` 找不到 `LSel.installMouse(view, {`');
  else if (installCall.indexOf('gesture:') < 0) {
    bad.push('`main.js` 调 `installMouse` 时没有把记下的手势传进去（`gesture:` 缺席）'
      + '⇒ 新视图永远不知道用户已经按下了，`bugs/0042` 原样复活');
  }

  const moveBody = sliceAfter(sel, 'function moveHandler(', 1800);
  if (!moveBody) bad.push('`selection.js` 找不到 `moveHandler`');
  else {
    if (moveBody.indexOf('if (!dragging)') < 0) {
      bad.push('`moveHandler` 没有 `!dragging` 的**续接**分支 —— 阅读态按下的那一次拖选会整段丢失（`bugs/0042`）');
    }
    if (moveBody.indexOf('startDrag(p0') < 0) {
      bad.push('`moveHandler` 的续接分支没有用 `startDrag(p0, …)` 建拖拽态 '
        + '（⛔ 别自己再写一份"点击次数 → 单位"的表，`bugs/0042`）');
    }
    if (moveBody.indexOf('posAt(pending)') < 0) {
      bad.push('`moveHandler` 的续接分支不是按**记下的坐标**取位置 —— 拿本次 move 的坐标当初点，'
        + '拖远一点就整段选空（`bugs/0042`）');
    }
  }

  const startBody = sliceAfter(sel, 'function startDrag(', 700);
  if (!startBody) bad.push('`selection.js` 找不到 `startDrag`');
  else {
    if (startBody.indexOf('wordAt(doc, p0)') < 0) {
      bad.push('`startDrag` 的双击分支没用 `wordAt` ⇒ 在词的起点双击会多吞前一个词（`bugs/0045`）');
    }
    if (startBody.indexOf('wordStop(') >= 0) {
      bad.push('`startDrag` 里又出现了 `wordStop(` —— 按词**移动**与点击**命中词**是两套语义（`bugs/0045`）');
    }
    if (startBody.indexOf('dragBase = { from:') < 0) {
      bad.push('`startDrag` 的词/行分支没记 `dragBase` —— 反向拖动会把刚选中的那段吐出去（`bugs/0044`）');
    }
  }

  const dragBody = sliceAfter(sel, 'function currentDrag(', 400);
  if (!dragBody) bad.push('`selection.js` 找不到 `currentDrag`');
  else if (dragBody.indexOf('dragRange(') < 0) {
    bad.push('`currentDrag` 没走 `dragRange` ⇒ `moveHandler` 与自动滚动 `步进()` 会各写一套方向判据'
      + '（滚起来之后锚点又漂，`bugs/0044`）');
  }
  if (countOf(sel, 'dragRange(') < 2) {
    bad.push('`dragRange(` 少于 2 处（定义 ＋ 调用）—— 方向判据必须**只有一份**（`bugs/0044`）');
  }

  const measureBody = sliceAfter(sel, 'function measure(', 1400);
  if (!measureBody) bad.push('`selection.js` 找不到 `measure`');
  else if (measureBody.indexOf('textRects') < 0) {
    bad.push('`measure()` 没走 `rectsFor(…, {textRects, …})` ⇒ 跨软换行的选区只画一条竖条'
      + '（`bugs/0043` 的原形态，DOM Range 才是真实矩形）');
  }
  if (/w:\s*4\b(?![0-9])/.test(sel)) {
    bad.push('`selection.js` 里还留着 `w: 4` 的兜底竖条 —— 那正是 `bugs/0043` 本尊');
  }

  return bad;
}

const BASE = {
  html: HTML_CODE,
  js: MAIN_CODE,
  liveSrc: LIVE_SRC,
  session: SESSION_CODE,
  configRs: CONFIG_CODE,
  cmdsRs: CMDS_CODE,
  dict: I18N.DICT,
  harness: HARNESS_CODE,
  objects: OBJECTS_CODE,
  cellSrc: CELL_CODE,
  taskSrc: TASK_CODE,
  selSrc: SEL_CODE,
};

test('⭐ 就地编辑的接线满足 `design/0047` 的结构判据', function () {
  const bad = score(BASE);
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

// ────────────────────────────────────────────────────────────────
// 变异自测（⚠️ 没有这一步，"全绿"不说明判据真的在看）
// ────────────────────────────────────────────────────────────────

test('⭐ 变异自测：三十六条写坏各必须让**对应**判据变红', function () {
  assert.deepStrictEqual(score(BASE), [], '基线必须先全绿，否则下面分不清是谁的红');

  // M1：`setupLive()` 挪到配置快照之前（整条能力不接线，且界面上毫无痕迹）
  const m1 = score(Object.assign({}, BASE, {
    js: BASE.js.replace('setupLive();', '/* moved */').replace(
      'applySnapshotLanguage(snap);', 'setupLive();\n    applySnapshotLanguage(snap);'),
  }));
  assert.ok(m1.some(function (x) { return x.indexOf('排在 applySnapshotLanguage 之前') >= 0; }), m1.join('\n'));

  // M2：`mountDocument` 里去掉那一次对齐（点哪块进哪块立刻不再是事实）
  const m2 = score(Object.assign({}, BASE, { js: BASE.js.replace('noteLive(payload);', 'void 0;') }));
  assert.ok(m2.some(function (x) { return x.indexOf('noteLive(payload) 的调用出现 0 次') >= 0; }), m2.join('\n'));

  // M3：`openDocument` 的脏闸被删（切文档丢未写盘的提交）
  const openBody = sliceAfter(BASE.js, 'async function openDocument(', 3000);
  const stripped = openBody.replace(/live\.(isDirty|isEditing)\(\)/g, 'void 0');
  const m3 = score(Object.assign({}, BASE, { js: BASE.js.replace(openBody, stripped) }));
  assert.ok(m3.some(function (x) { return x.indexOf('切换文档') >= 0; }), m3.join('\n'));

  // M4：白名单里多装一个带键位的扩展（⚠️ 目标必须与现在的写法一致——扩展是逐个 `push` 的）
  //    ⚠️ 目标串一旦与 `main.js` 漂开，`.replace` 就**什么都没改**，这条变异自测会假绿。
  const 装语法 = 'extensions.push(CM6.markdown({ base: CM6.markdownLanguage }));';
  const m4 = score(Object.assign({}, BASE, {
    js: BASE.js.replace(装语法, 装语法 + '\n    extensions.push(CM6.historyKeymap);'),
  }));
  assert.ok(m4.some(function (x) { return x.indexOf('historyKeymap') >= 0; }), m4.join('\n'));

  // M5：串行链的链尾不再吞拒绝
  const m5 = score(Object.assign({}, BASE, {
    js: BASE.js.replace('liveChain = run.then(function () {}, function () {});', 'liveChain = run;'),
  }));
  assert.ok(m5.some(function (x) { return x.indexOf('链尾没有吞拒绝') >= 0; }), m5.join('\n'));

  // M6：字典里删掉一个键（状态条上会出现键名）
  const dict = { zh: Object.assign({}, I18N.DICT.zh), en: Object.assign({}, I18N.DICT.en) };
  delete dict.zh['status.live-align'];
  delete dict.en['status.live-align'];
  const m6 = score(Object.assign({}, BASE, { dict: dict }));
  assert.ok(m6.some(function (x) { return x.indexOf('zh 少了 status.live-align') >= 0; }), m6.join('\n'));

  // M7：`swapLiveView` 不再搬盒子（正文整体上跳 15.4px、列表左跳，几何判据一无所知）
  // ⚠️ 只改 swap 那一段：`makeLiveView` 里也有同一句，全文 `replace` 会先命中**它**。
  const swap7 = BASE.js.indexOf('function swapLiveView(');
  const m7 = score(Object.assign({}, BASE, {
    js: BASE.js.slice(0, swap7) + BASE.js.slice(swap7).replace('LBox.applyBox(host, el);', 'void 0;'),
  }));
  assert.ok(m7.some(function (x) { return x.indexOf('没搬被换掉那一块的盒子') >= 0; }), m7.join('\n'));

  // M8：量的时机挪到摘节点之后（脱树 ⇒ 全空串 ⇒ 与没写这段代码等价）
  const swapAt = BASE.js.indexOf('function swapLiveView(');
  const swapSrc = BASE.js.slice(swapAt);
  const badOrder = swapSrc
    .replace('    if (LBox && typeof LBox.applyBox === \'function\') LBox.applyBox(host, el);\n', '')
    .replace('if (parent) parent.removeChild(el);',
      'if (parent) parent.removeChild(el);\n    LBox.applyBox(host, el);');
  const m8 = score(Object.assign({}, BASE, { js: BASE.js.slice(0, swapAt) + badOrder }));
  assert.ok(m8.some(function (x) { return x.indexOf('先摘节点后量盒子') >= 0; }), m8.join('\n'));

  // M9：`bodyLines` 不再交给装饰层（`bugs/0015` 原样打回：标题块里回车出来的新行仍是标题尺度）
  //    ⚠️ 只删那一行，⛔ 不动 `createField` 本身——纯逻辑判据在那边全绿，这正是它要防的形态。
  const m9 = score(Object.assign({}, BASE, {
    js: BASE.js.replace(/\n\s*bodyLines: [^\n]*\n/, '\n'),
  }));
  assert.ok(m9.some(function (x) { return x.indexOf('没把 `bodyLines` 交给装饰层') >= 0; }), m9.join('\n'));

  // M10：`⌘↵` 挪回裸 `Enter` 之后（2026-10-27 的真实写法——它**看起来完全正常**，
  //    但第一个条件就是 `key === 'Enter'` ⇒ 永远到不了，按了没有任何反应）
  //    ⚠️ 2026-10-28：`⌘↵` 那一支改成了"新起一段"（`bugs/0024`）⇒ 目标串同批更新，
  //    ⛔ 别让它与 `main.js` 漂开（漂开了 `.replace` 什么都没改，这条变异自测会**假绿**）。
  const modEnterBranch =
    "      if (mods.cmd && (ev.key === 'Enter' || ev.key === 'NumpadEnter')) {\n" +
    '        ev.preventDefault();\n' +
    '        liveSerial(function () { return startNewParagraph(); }).then(function (ok) {\n' +
    "          if (!ok) liveSerial(function () { return leaveLive({ reason: 'mod-enter' }); });\n" +
    '        });\n' +
    '        return;\n' +
    '      }\n';
  assert.ok(BASE.js.indexOf(modEnterBranch) >= 0, 'M10 的目标串与 main.js 漂开了（变异会假绿）');
  const m10 = score(Object.assign({}, BASE, {
    js: BASE.js
      .replace(modEnterBranch, '')
      .replace("      if (ev.key === 'Escape') {",
        "      if (mods.cmd && (ev.key === 'Enter' || ev.key === 'NumpadEnter')) {\n" +
        '        return;\n' +
        '      }\n' +
        "      if (ev.key === 'Escape') {"),
  }));
  assert.ok(m10.some(function (x) { return x.indexOf('永远到不了') >= 0; }), m10.join('\n'));

  // M11：摘掉文档级键盘兜底（焦点一离开离屏 textarea，整个应用里没有任何一条退路）
  const m11 = score(Object.assign({}, BASE, {
    js: BASE.js.replace("document.addEventListener('keydown', onLiveGlobalKey, true);", 'void 0;'),
  }));
  assert.ok(m11.some(function (x) { return x.indexOf('onLiveGlobalKey` 出现 0 次') >= 0; }), m11.join('\n'));

  // M12：`onLiveDocDown` 的落空分支退回裸 `return`（点空白 / 结构块 / 块间隙 / 表格的三种落空全都不退出）
  //    ⚠️ `design/0049` 起 `leaveAway(` 多出两个单元格理由（`cell-structural` / `cell-pairing`），
  //    不一起打掉的话计数还剩 3 ⇒ 这条变异**不再变红**，而"全绿"看起来毫无异常。
  const downAt = BASE.js.indexOf('function onLiveDocDown(');
  const m12 = score(Object.assign({}, BASE, {
    js: BASE.js.slice(0, downAt)
      + BASE.js.slice(downAt).replace(/leaveAway\('(blank|structural|cell-[a-z-]+)'\)/g, 'void 0'),
  }));
  assert.ok(m12.some(function (x) { return x.indexOf('落空分支只有') >= 0; }), m12.join('\n'));

  // ── `design/0049`（表格单元格）的四条同族变异 ────────────────────────────

  // M13：依赖里去掉 `cellNodeOf`（切换目标后控制器找不回那一格 ⇒ 走格第二下就断）
  const m13 = score(Object.assign({}, BASE, { js: BASE.js.replace('cellNodeOf: function', 'void 0, _x: function') }));
  assert.ok(m13.some(function (x) { return x.indexOf('没有 cellNodeOf') >= 0; }), m13.join('\n'));

  // M14：布局冻结不按 `isCell` 生效（列宽重算 ⇒ 整张表跳一下，而等高校验量不到）
  const m14 = score(Object.assign({}, BASE, {
    js: BASE.js.replace('const thaw = isCell && LCell ? LCell.freezeTableLayout(el) : null;', 'const thaw = null;'),
  }));
  assert.ok(m14.some(function (x) { return x.indexOf('没在 `isCell` 时调') >= 0; }), m14.join('\n'));

  // M15：不校验 DOM 格子数与载荷格子数（错位一格 ⇒ 改的是**别的格子**，屏幕上完全看不出来）
  const m15 = score(Object.assign({}, BASE, {
    js: BASE.js.replace('domCount !== spans.length || flat < 0', 'flat < 0'),
  }));
  assert.ok(m15.some(function (x) { return x.indexOf('INV-CELL-06') >= 0; }), m15.join('\n'));

  // M16：单元格提交退回整块提交（同排其余格子会被一起重写，两侧填充也保不住）
  //    ⚠️ `design/0054` **换靶**：提交不再由 `commitCell` 直接调 `session.commit`，
  //    而是交给 `publish()` 的 `range` ⇒ 靶子跟着搬到那一行（⛔ 别让变异静默落空）。
  const m16Hit = 'session.commit({ from: from, to: from + 1 }, [nextLine]);';
  assert.strictEqual(
    LIVE_SRC.split('range: { from: from, to: from + 1 },').length - 1,
    1,
    'M16 的靶子必须**恰好命中 1 处**（命中 0 处 = 变异没做，红不了）'
  );
  void m16Hit;
  const m16 = score(Object.assign({}, BASE, {
    liveSrc: LIVE_SRC.replace(
      'range: { from: from, to: from + 1 },',
      'range: { from: from, to: from + 2 },'),
  }));
  assert.ok(m16.some(function (x) { return x.indexOf('一行换一行') >= 0; }), m16.join('\n'));

  // ── `design/0051`（任务项打勾）的三条同族变异 ────────────────────────────

  // M17：不摘 `disabled`（WebKit 对 disabled 控件不派发鼠标事件 ⇒ 点了**什么都不发生**，
  //      而且没有任何报错——这条路上连"没反应"都没有地方看得见）
  //    ⚠️ 2026-10-29 第 15 条**换靶**：`removeAttribute` 已随武装搬进 `live/task.js`。
  const m17 = score(Object.assign({}, BASE, {
    taskSrc: BASE.taskSrc.replace("box.removeAttribute('disabled');", 'void 0;'),
  }));
  assert.ok(m17.some(function (x) { return x.indexOf('方框收不到点击') >= 0; }), m17.join('\n'));

  // M18：`noteLive` 不武装（打勾一次之后重渲出来的方框又回到 disabled ⇒ 第二次再也点不动）
  const m18 = score(Object.assign({}, BASE, { js: BASE.js.replace('    armTaskBoxes();\n', '') }));
  assert.ok(m18.some(function (x) { return x.indexOf('noteLive 不武装任务项方框') >= 0; }), m18.join('\n'));

  // M19：脏快照挪到提交之后（那时一定为真 ⇒ 打勾永远不写盘，屏幕上勾了、磁盘上没变）
  const m19 = score(Object.assign({}, BASE, {
    liveSrc: LIVE_SRC.replace(
      '      const wasDirty = dirty();\n',
      '').replace(
      '      const res = session.commit({ from: idx, to: idx + 1 }, [nextLine]);',
      '      const res = session.commit({ from: idx, to: idx + 1 }, [nextLine]);\n      const wasDirty = dirty();'),
  }));
  assert.ok(m19.some(function (x) { return x.indexOf('wasDirty 在提交之后才取') >= 0; }), m19.join('\n'));

  // ── `design/0052` U6 的两条同族变异（`INV-KERNEL-05`：块永远进得去）────────────

  // M20：换掉旧节点之后**不补锚定**（⇒ 点进去下面的内容整体窜一行，而屏幕上没有任何报错）
  const m20 = score(Object.assign({}, BASE, {
    js: BASE.js.replace('req.view.anchorAt({ y: anchorY });', 'void anchorY;'),
  }));
  assert.ok(m20.some(function (x) { return x.indexOf('没调 `view.anchorAt`') >= 0; }), m20.join('\n'));

  // M21：几何拒收**加回来**（`bugs/0025` 那一族的病根：块"点了没反应"，连 B 段判据都不产生）
  const m21 = score(Object.assign({}, BASE, {
    liveSrc: BASE.liveSrc.replace(
      'if (!wantCell && diff < -HEIGHT_TOLERANCE) {',
      "if (Math.abs(diff) > HEIGHT_TOLERANCE) { return { ok: false, why: 'geometry' }; }\n"
      + '      if (!wantCell && diff < -HEIGHT_TOLERANCE) {'),
  }));
  assert.ok(m21.some(function (x) { return x.indexOf('按几何') >= 0; }), m21.join('\n'));

  // ── `bugs/0024`（`⌘↵` 新起一段，2026-10-28 用户更正）的两条同族变异 ────────────

  // M22：`⌘↵` 退回"直接退出到阅读态"（2026-10-27 那套错误需求的形态，用户 2026-10-28 否掉）
  //    ⇒ 两处接线都不再走 `startNewParagraph`，"块内与兜底都接上"那条判据必红。
  const m22 = score(Object.assign({}, BASE, {
    js: BASE.js.replace(
      /liveSerial\(function \(\) \{ return startNewParagraph\(\); \}\)/g,
      "liveSerial(function () { return leaveLive({ reason: 'mod-enter' }); })"),
  }));
  assert.ok(
    m22.some(function (x) { return x.indexOf('接到 startNewParagraph') >= 0; }),
    m22.join('\n')
  );

  // M23：只插**一行**空行（comrak 把相邻非空行并进同一段 ⇒ 用户敲的第一个字会并进上一块，
  //    屏幕上表现为"新写的字跑进了引用块里"，而任何一条纯逻辑判据都看不见）
  const m23 = score(Object.assign({}, BASE, {
    liveSrc: BASE.liveSrc.replace("['', '', '']", "['']"),
  }));
  assert.ok(
    m23.some(function (x) { return x.indexOf('三行空行') >= 0; }),
    m23.join('\n')
  );

  // M24：把 2026-10-28 探针抓到的真缺陷原样打回 —— `caret()` 绕道 `LSel.range()` 取 `.head`
  //    （`range()` 只有 `{from, to}`）⇒ `undefined` ⇒ 撤销恒回段首，而 `W1`/纯逻辑/类型层全绿。
  const caretGood = 'caret: function () { return view.state.selection.main.head; },';
  assert.ok(BASE.js.indexOf(caretGood) >= 0, 'M24 的目标串与 main.js 漂开了（变异会假绿）');
  const m24 = score(Object.assign({}, BASE, {
    js: BASE.js.replace(caretGood, 'caret: function () { return LSel.range(sel).head; },'),
  }));
  assert.ok(
    m24.some(function (x) { return x.indexOf('撤销之后光标恒回段首') >= 0; }),
    m24.join('\n')
  );

  // M25：把 2026-10-28 用户实测的缺陷原样打回 —— `swapLiveCell` **不重写 `host.className`**
  //    ⇒ 那一格换进 `<td>` 之后仍带 `cm-rmd-offscreen`（`visibility: hidden`）
  //    ⇒ 格子里的字整片消失、光标画在离屏层里、点它还穿到 `<td>` 上。
  //    ⚠️ 目标串必须与现在的写法一致；漂开了 `.replace` 什么都不改，这条变异自测会**假绿**。
  const cellGood = "host.className = 'cm-rmd-liveHost cm-rmd-cell';";
  assert.ok(BASE.js.indexOf(cellGood) >= 0, 'M25 的目标串与 main.js 漂开了（变异会假绿）');
  const m25 = score(Object.assign({}, BASE, {
    js: BASE.js.replace(cellGood, '/* 变异：不摘离屏标记 */'),
  }));
  assert.ok(
    m25.some(function (x) { return x.indexOf('swapLiveCell 没有重写 host 的 className') >= 0; }),
    m25.join('\n')
  );

  // M26：把单元格的 `Enter` 打回 `'walk'`（`bugs/0035` 之前的行为：回车走格、不换行）
  //    ⇒ 用户报的那条需求原样复现（「enter 键无法换到下一行，直接到表格的下一行中了」）。
  //    ⚠️ 目标必须**按位置取**：`BLOCK` 里也有一个 `('newline'),`，
  //    而注释已被 `stripBlockComments` 换成空格 ⇒ 拿带注释的整行去匹配会**假绿**。
  const cellAt = OBJECTS_CODE.indexOf('const CELL = Object.freeze({');
  assert.ok(cellAt >= 0, 'M26 找不到 `CELL`（变异会假绿）');
  const cellSeg = OBJECTS_CODE.slice(cellAt, cellAt + 400);
  assert.strictEqual(countOf(cellSeg, "('newline'),"), 1, 'M26 的靶子必须**恰好命中 1 处**');
  const m26 = score(Object.assign({}, BASE, {
    objects: OBJECTS_CODE.slice(0, cellAt) + cellSeg.replace("('newline'),", "('walk'),")
      + OBJECTS_CODE.slice(cellAt + 400),
  }));
  assert.ok(
    m26.some(function (x) { return x.indexOf('单元格的 `Enter` 不是换行') >= 0; }),
    m26.join('\n')
  );

  // M27：**进入单元格不解码**（`cellMod.decode(raw)` → `raw`）⇒ 源码里的 `<br>` 会原样显示。
  //    ⚠️ 这一条是 M26 的**负对照**：它必须只打红"没解码"那一条，而 `Enter` 那条**保持绿**。
  const decodeGood = '        text = cellMod.decode(raw);';
  assert.ok(BASE.liveSrc.indexOf(decodeGood) >= 0, 'M27 的目标串与 index.js 漂开了（变异会假绿）');
  assert.strictEqual(countOf(BASE.liveSrc, decodeGood), 1, 'M27 的靶子必须**恰好命中 1 处**');
  const m27 = score(Object.assign({}, BASE, {
    liveSrc: BASE.liveSrc.replace(decodeGood, '        text = raw;'),
  }));
  assert.ok(
    m27.some(function (x) { return x.indexOf('进入单元格时没有 `cellMod.decode(') >= 0; }),
    m27.join('\n')
  );
  assert.ok(
    !m27.some(function (x) { return x.indexOf('单元格的 `Enter` 不是换行') >= 0; }),
    'M27 只该打红"没解码"那一条，⛔ 别把"Enter 不是换行"一起判红\n' + m27.join('\n')
  );

  // M28：状态机的 `paste` 入口往回退成 `normalizeNewlines(e.text)`（**绕过对象约束**）
  //    ⇒ 粘贴两行又会被排进格子。⚠️ 四条入口里**只坏一条**，正是最容易被漏掉的那种形态
  //    （其余三条还在，屏幕上"输入法上屏是好的、只有粘贴会跳"）。
  const pasteInGood = 'const text = textIn(e.text);';
  assert.ok(BASE.liveSrc.indexOf(pasteInGood) >= 0, 'M28 的目标串与 input.js 漂开了（变异会假绿）');
  const m28 = score(Object.assign({}, BASE, {
    liveSrc: BASE.liveSrc.replace(pasteInGood, 'const text = normalizeNewlines(e.text);'),
  }));
  assert.ok(
    m28.some(function (x) { return x.indexOf('`textIn(` 只有') >= 0; }),
    m28.join('\n')
  );

  // M29：呈现策略退回接线处 `cellContext: isCell`（`design/0054` 之前那一行）
  //    ⇒ 点进 `# 普通格子` 那一格时字号/行高当场变掉（2026-10-28 评审 P2-③ 的原形态），
  //    而**任何**行为判据都看不见（探针只量几何，几何在块级那一套里是对得上的）。
  const ctxGood = 'cellContext: obj.inlineOnly,';
  assert.ok(BASE.js.indexOf(ctxGood) >= 0, 'M29 的目标串与 main.js 漂开了（变异会假绿）');
  const m29 = score(Object.assign({}, BASE, {
    js: BASE.js.replace(ctxGood, 'cellContext: isCell,'),
  }));
  assert.ok(
    m29.some(function (x) { return x.indexOf('`cellContext` 不是从策略推导的') >= 0; }),
    m29.join('\n')
  );

  // M30：组合串覆盖层不再对齐光标那一行（2026-10-29 用户实测：标题块第二行的拼音按标题字号画）
  //    ⇒ 覆盖层只剩"继承 host"，而 host 是**块级**文字层。⚠️ 两件事必须同时打红才对得上
  //    产品那句 `syncPreeditMetrics(preeditEl);` 的两半：① 没调用；② 量的不是那一行。
  const preeditCall = 'syncPreeditMetrics(preeditEl);';
  assert.ok(BASE.js.indexOf(preeditCall) >= 0, 'M30 的目标串与 main.js 漂开了（变异会假绿）');
  const m30 = score(Object.assign({}, BASE, { js: BASE.js.replace(preeditCall, 'void 0;') }));
  assert.ok(
    m30.some(function (x) { return x.indexOf('没给组合串对齐**光标那一行**的排版') >= 0; }),
    m30.join('\n')
  );
  const m30b = score(Object.assign({}, BASE, {
    js: BASE.js.replace('view.domAtPos(sel.head)', 'view.domAtPos(0)'),
  }));
  assert.ok(
    m30b.some(function (x) { return x.indexOf('`caretLineEl` 不是从 `view.domAtPos(sel.head)` 取那一行的') >= 0; }),
    m30b.join('\n')
  );
  assert.strictEqual(m30b.length, 1,
    'M30b 只该打红"量的不是那一行"，⛔ 别把"没调用"一起判红\n' + m30b.join('\n'));

  // ── `bugs/0042`–`0046`（2026-10-29 鼠标拖选五条）的六条同族变异 ────────────
  //    ⚠️ 这六处的失效形态**全都不报错**：拖选丢一段、多选一个词、高亮少画几行。

  // M31：`main.js` 不再把手势交给 `installMouse`（`bugs/0042` 的接线面）
  const gesturePass = 'gesture: gesture,';
  assert.strictEqual(countOf(BASE.js, gesturePass), 1, 'M31 的靶子必须**恰好命中 1 处**');
  const m31 = score(Object.assign({}, BASE, { js: BASE.js.replace(gesturePass, '') }));
  assert.ok(
    m31.some(function (x) { return x.indexOf('`gesture:` 缺席') >= 0; }),
    m31.join('\n')
  );

  // M32：只在一个入口记手势（单元格那条路点进去的第一次拖选整段丢失）
  const noteDown = 'noteDownGesture(ev);';
  assert.strictEqual(countOf(BASE.js, noteDown), 2, 'M32 的靶子必须**恰好命中 2 处**');
  const m32 = score(Object.assign({}, BASE, { js: BASE.js.replace(noteDown, 'noop(ev)') }));
  assert.ok(
    m32.some(function (x) { return x.indexOf('`noteDownGesture(ev);` 少于 2 处') >= 0; }),
    m32.join('\n')
  );

  // M33：`moveHandler` 不再接手（`!dragging` 那个分支消失）
  const dragGuard = 'if (!dragging) {';
  assert.strictEqual(countOf(BASE.selSrc, dragGuard), 1, 'M33 的靶子必须**恰好命中 1 处**');
  const m33 = score(Object.assign({}, BASE, {
    selSrc: BASE.selSrc.replace(dragGuard, 'if (false) {'),
  }));
  assert.ok(
    m33.some(function (x) { return x.indexOf('没有 `!dragging` 的**续接**分支') >= 0; }),
    m33.join('\n')
  );

  // M34：双击分支退回 `wordStop`（`bugs/0045` 原样打回）
  const wordHit = 'wordAt(doc, p0)';
  assert.strictEqual(countOf(BASE.selSrc, wordHit), 1, 'M34 的靶子必须**恰好命中 1 处**');
  const m34 = score(Object.assign({}, BASE, {
    selSrc: BASE.selSrc.replace(wordHit, 'wordStop(doc, p0, -1)'),
  }));
  assert.ok(
    m34.some(function (x) { return x.indexOf('没用 `wordAt`') >= 0; }),
    m34.join('\n')
  );
  assert.ok(
    m34.some(function (x) { return x.indexOf('又出现了 `wordStop(`') >= 0; }),
    m34.join('\n')
  );

  // M35：`measure()` 不再问 DOM Range（`bugs/0043` 的原形态：只有一条竖条）
  const textRectsPass = 'textRects: textRects,';
  assert.strictEqual(countOf(BASE.selSrc, textRectsPass), 1, 'M35 的靶子必须**恰好命中 1 处**');
  const m35 = score(Object.assign({}, BASE, {
    selSrc: BASE.selSrc.replace(textRectsPass, ''),
  }));
  assert.ok(
    m35.some(function (x) { return x.indexOf('没走 `rectsFor(…, {textRects') >= 0; }),
    m35.join('\n')
  );

  // M36：`currentDrag` 自己判方向（⛔ 与自动滚动共用一处）
  const dragCall = 'return dragRange(view.state.doc, dragUnit, base, p);';
  assert.strictEqual(countOf(BASE.selSrc, dragCall), 1, 'M36 的靶子必须**恰好命中 1 处**');
  const m36 = score(Object.assign({}, BASE, {
    selSrc: BASE.selSrc.replace(dragCall, 'return { anchor: dragAnchor, head: p };'),
  }));
  assert.ok(
    m36.some(function (x) { return x.indexOf('`currentDrag` 没走 `dragRange`') >= 0; }),
    m36.join('\n')
  );
});
