// `design/0082`（2026-11-15 用户原话「cmd + N 可以像 Vscode 和 Sublime 一样，
// 先新建文件，然后再保存，不需要先建一个目录。」）的判据。
//
// # 这一组守的是什么
//
// 先建后存的错法**全是静默的**——一个异常都不抛，界面上看起来"什么都没发生"：
//   · `⌘N` 又走回"在树里建文件"那条路 ⇒ 没有目录时失败、有目录时落盘（用户要的是**草稿**）；
//   · 脏内容没先问就换了文档 ⇒ 一次静默的数据丢失（`INV-EDIT-06`）；
//   · 保存时**前端**传路径 / 走 `save_document` ⇒ 绕过后端面板那道授权（根 `CLAUDE.md`）；
//   · 用户在系统面板里**取消** ⇒ 被当成"已保存"（清脏标记、关窗不再问 = 丢字）；
//   · 关窗时不问 / 问了却关不掉（`preventDefault` 之后没人 `destroy`）；
//   · 就地编辑那条路（`live`）不认草稿 ⇒ 第一次提交之后每块都撞一条假的外部改动。
// ⇒ 判据是**源码级接线**（`main.js` / `live/index.js` / `editor/save.js` / `session.js` /
//   capabilities / i18n），外加 `editor.test.js` 里保存器取消行为的行为判据。
//
// ⚠️ 源码级判据一律**先剥注释**（本仓注释里大量写着"⛔ 别写成 X"，直接 grep 原文会把
//    正确的注释判成缺陷），且逐块解析（⛔ 不用"命中处前 N 字符"回看——那会捞到邻项）。
// ⚠️ 最后是**变异自测**：同一套判据喂给"故意写坏的副本"必须变红，
//    否则"全绿"不说明判据在看在看（`.claude/rules/tests.md`）。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = function (p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); };

/** 挖空 `/* … *\/`（保留换行，行号仍然对得上）。 */
function stripBlockComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, '');
  });
}

/** 取 `function name(…) { … }` 的**函数体**（按花括号配平，⛔ 不按"前 N 字符"回看）。 */
function fnBody(src, name) {
  const head = 'function ' + name + '(';
  const i = String(src).indexOf(head);
  if (i < 0) return '';
  const open = String(src).indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, j);
    }
  }
  return '';
}

/** 取 `head … { … }` 的体（`head` 必须是**完整**的声明前缀，⛔ 别只给方法名）。 */
function bodyAfter(src, head) {
  const i = String(src).indexOf(head);
  if (i < 0) return '';
  const open = String(src).indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, j);
    }
  }
  return '';
}

/** 数一个串在源码里出现几次（⛔ 不用 `split().length` —— 空串会得到 1，容易读错）。 */
function count(src, needle) {
  return String(src).split(needle).length - 1;
}

const RAW = {
  main: read('src/main.js'),
  live: read('src/live/index.js'),
  save: read('src/editor/save.js'),
  session: read('src/services/session.js'),
  caps: read('src-tauri/capabilities/default.json'),
  i18n: read('src/services/i18n.js'),
};

/**
 * 判据集合：输入**可替换的源码副本**，输出"哪里不对"。
 * ⚠️ 写成纯函数是为了下面的变异自测——同一套判据喂坏副本，必须变红。
 */
function score(S) {
  const bad = [];
  const main = stripBlockComments(S.main);
  const live = stripBlockComments(S.live);
  const save = stripBlockComments(S.save);
  const sess = stripBlockComments(S.session);

  // ── ① `⌘N`：一律新建**草稿**，且**零写盘** ──
  const nf = fnBody(main, 'onNewFile');
  if (!nf) {
    bad.push('`main.js` 里没有 `onNewFile`');
  } else {
    // ⛔ 覆盖层开着时不许抢焦点（与 `historyGo` 同一条口径）
    if (!/if \(overlayOpen\(\)\) return;/.test(nf)) bad.push('`onNewFile` 没有挡覆盖层');
    // ⭐ 脏闸：换文档之前必须先问（`INV-EDIT-06`，用户丢了字才发现就没有意义了）
    if (!/await gateSwitchDoc\(name, onNewFile\)/.test(nf)) {
      bad.push('`onNewFile` 没有先过 `gateSwitchDoc`（脏内容会被静默丢掉）');
    }
    if (count(nf, 'S.newUntitled()') !== 1) bad.push('`onNewFile` 没有恰好调用一次 `S.newUntitled()`');
    // ⭐ `INV-OPEN-06` 的同族：⌘N 不许有任何落盘/建文件动作
    if (/createEntry\(|'create_entry'/.test(nf)) bad.push('`onNewFile` 又去建文件了（`design/0082`：先建后存，零写盘）');
    // ⛔ 这一步不该有后端参与（全部经 `S.newUntitled` 的薄封装）
    if (/T\.call\(/.test(nf)) bad.push('`onNewFile` 直接发了 IPC（绕过 `services/session.js`）');
    if (!/mountDocument\(out\.payload\)/.test(nf)) bad.push('`onNewFile` 没有把载荷交给 `mountDocument`');
    if (!/await enterEdit\(\)/.test(nf)) bad.push('`onNewFile` 挂上之后没有进编辑态（草稿只活在编辑态）');
    if (!/'fail\.new\.unavailable'/.test(nf)) bad.push('`onNewFile` 失败时没有走失败条（`INV-EDIT-05` 同族：不许静默）');
  }

  // ── ② 保存分流：草稿走 `save_untitled`，真实文档走原路 ──
  const sd = fnBody(main, 'saveDraft');
  if (!sd) {
    bad.push('`main.js` 里没有 `saveDraft`（草稿的保存入口）');
  } else {
    if (!/if \(!out\) return \{ cancelled: true \};/.test(sd)) {
      bad.push('`saveDraft` 把"面板被取消"当成了别的（`null` 回包 ⇒ ⛔ 不许写成 `{written:true}`）');
    }
    if (!/S\.saveUntitled\(id, text, \+\+editReqSeq\)/.test(sd)) {
      bad.push('`saveDraft` 没有走 `S.saveUntitled`（落点由后端面板产生，前端⛔ 不传路径）');
    }
    if (!/S\.adoptSavedDraft\(out\)/.test(sd)) {
      bad.push('`saveDraft` 成功后没有就地采纳新身份（`session.js` 是唯一改动点）');
    }
  }
  const send = bodyAfter(main, 'send: function (text) {');
  if (!/isDraftDoc\(\) \? saveDraft\(text\) : S\.saveDocument\(text, \+\+editReqSeq\)/.test(send)) {
    bad.push('分栏保存器的 `send` 没有按 `isDraftDoc()` 分流（草稿会走 `save_document` ⇒ 没有文档可写）');
  }

  // ── ③ 脏闸的两条实现都要认"取消"（⛔ 不许把取消当成功继续） ──
  const pld = fnBody(main, 'promptLeaveEdit');
  if (!pld) bad.push('`main.js` 里没有 `promptLeaveEdit`');
  else {
    const cancel = pld.indexOf('out && out.cancelled');
    const proceed = pld.indexOf('if (out) { proceed(); return; }');
    if (cancel < 0) bad.push('`promptLeaveEdit` 不认 `{cancelled:true}`（面板里点取消 = 把用户的字丢掉了）');
    else if (proceed < 0 || cancel > proceed) bad.push('`promptLeaveEdit` 的取消分支排在"继续"之后（顺序错了等于没判）');
  }
  const las = fnBody(main, 'liveAskSwitch');
  if (!las) bad.push('`main.js` 里没有 `liveAskSwitch`');
  else {
    const cancel = las.indexOf('out && out.cancelled');
    const proceed = las.indexOf('if (out) { proceed(); return; }');
    if (cancel < 0) bad.push('`liveAskSwitch` 不认 `{cancelled:true}`');
    else if (proceed < 0 || cancel > proceed) bad.push('`liveAskSwitch` 的取消分支排在"继续"之后');
  }
  // `save.js` 是**唯一**清脏标记的地方 ⇒ 取消必须在它之前短路
  const sv = fnBody(save, 'save');
  if (!sv) bad.push('`editor/save.js` 里找不到 `save()`');
  else {
    const cancel = sv.indexOf('out && out.cancelled');
    const clean = sv.indexOf('safeCall(opts.onClean');
    if (cancel < 0) bad.push('`editor/save.js` 不认 `{cancelled:true}`');
    else if (clean < 0 || cancel > clean) bad.push('`editor/save.js` 的取消分支排在 `onClean` 之后（脏标记会被清掉）');
  }

  // ── ④ 就地编辑（live）那条路：身份里带 `draft`，保存后回填新身份 ──
  const idOf = fnBody(live, 'identOfPayload');
  if (!/draft: \(p && p\.draft\) \|\| null/.test(idOf)) {
    bad.push('`identOfPayload` 没有把 `draft` 放进身份（草稿的 `realPath` 是空串，两者分不开）');
  }
  const mism = fnBody(live, 'identityMismatch');
  if (!/if \(id && id\.draft\) return '';/.test(mism)) {
    bad.push('`identityMismatch` 没有对草稿短路（第一次提交之后每块都会撞一条假的外部改动）');
  }
  const dsv = fnBody(live, 'doSave');
  if (!/if \(saved && saved\.cancelled\) return false;/.test(dsv)) {
    bad.push('`doSave` 不认 `{cancelled:true}`（会把取消后的基线往前推）');
  }
  if (!/if \(ident0\.draft && saved && saved\.path\)/.test(dsv)) {
    bad.push('`doSave` 保存草稿成功后没有回填身份（下一次 `begin_edit` 会拿新路径比旧空串）');
  }
  const lsd = bodyAfter(main, 'saveDisk: function (a) {');
  if (!/if \(isDraftDoc\(\)\) \{/.test(lsd) || !/saveDraft\(a\.text\)/.test(lsd)) {
    bad.push('live 的 `saveDisk` 没有按 `isDraftDoc()` 分流到 `saveDraft`');
  }

  // ── ⑤ 挂载：草稿不高亮树、状态条说「未命名」 ──
  const mount = fnBody(main, 'mountDocument');
  if (!/payload\.draft/.test(mount)) {
    bad.push('`mountDocument` 没有按 `payload.draft` 分流（草稿会把树里真实文档的高亮抹掉）');
  }

  // ── ⑥ 关窗守卫（`design/0082` §4：用户裁定"第一期就加"） ──
  const guard = fnBody(main, 'installCloseGuard');
  if (!guard) {
    bad.push('`main.js` 里没有 `installCloseGuard`（有未保存内容时关窗会直接丢字）');
  } else {
    if (!/\.onCloseRequested\(/.test(guard)) bad.push('关窗守卫没有挂 `onCloseRequested`');
    if (!/event\.preventDefault\(\)/.test(guard)) {
      bad.push('关窗守卫没有 `preventDefault`（问句还没答，窗口已经关了）');
    }
    if (!/if \(!hasUnsavedChanges\(\)\) return;/.test(guard)) {
      bad.push('关窗守卫没有"不脏就放行"（挂上监听之后 Rust 一律不关，漏了这条窗口再也关不掉）');
    }
    if (!/'edit\.ask-close-window'/.test(guard)) bad.push('关窗守卫没有问句键 `edit.ask-close-window`');
    if (!/win\.destroy\(\)/.test(guard)) bad.push('关窗守卫的"丢弃"分支没有关窗');
  }
  const unsaved = fnBody(main, 'hasUnsavedChanges');
  if (!/if \(editing\) return !!editDirty;/.test(unsaved) || !/live && live\.isDirty\(\)/.test(unsaved)) {
    bad.push('`hasUnsavedChanges` 只覆盖了一种编辑态（分栏与就地都要）');
  }
  const cas = fnBody(main, 'closeAfterSave');
  if (!/if \(!out \|\| out\.cancelled\) return;/.test(cas)) {
    bad.push('`closeAfterSave` 在取消 / 失败时仍会关窗（`{cancelled:true}` ⇒ 用户的字没了）');
  }
  if (!/installCloseGuard\(\);\s*\n/.test(main)) bad.push('`bootInner` 里没有调 `installCloseGuard()`');
  // ACL：`destroy` 不放行 ⇒ 关窗守卫会让窗口**永远关不掉**（JS 那层自己发的 destroy 被静默拒）
  if (!/"core:window:allow-destroy"/.test(S.caps)) {
    bad.push('capabilities 没有 `core:window:allow-destroy`（挂上监听之后窗口关不掉）');
  }

  // ── ⑦ 服务层：草稿身份的四件套必须同批改 ──
  const adopt = fnBody(sess, 'adoptSavedDraft');
  if (!adopt) bad.push('`session.js` 里没有 `adoptSavedDraft`');
  else {
    ['doc.draft = null;', 'doc.path = out.path;', 'doc.real_path = out.path;', 'doc.doc_dir = out.doc_dir',
      'doc.doc_seq = out.doc_seq;', 'state.currentPath = out.path;'].forEach(function (needle) {
      if (adopt.indexOf(needle) < 0) bad.push('`adoptSavedDraft` 漏了一行：`' + needle + '`（两份真值）');
    });
  }
  if (!/^\s*adoptSavedDraft,$/m.test(sess)) bad.push('`adoptSavedDraft` 没有导出');
  if (!/state\.currentPath = payload\.real_path;/.test(fnBody(sess, 'newUntitled'))) {
    bad.push('`newUntitled` 没有把草稿的 `real_path`（空串）镜像进 `currentPath`');
  }

  // ── ⑧ i18n：三条新文案中英各一句 ──
  // ⚠️ 这里**不剥块注释**：`i18n.js` 里有形如 `/*` 的示例串，块注释正则会从那里一路
  //    吞到下一个 `*/`（实测吞掉 72% 的正文）⇒ 换成"整行就是一条字典项"的严格形状，
  //    ⛔ 注释里不会出现这种行（注释都以 `//` 或 `*` 打头）。
  ['doc.untitled', 'save.cancelled', 'edit.ask-close-window'].forEach(function (k) {
    const re = new RegExp("^\\s*'" + k.replace(/\./g, '\\.') + "':", 'gm');
    const hits = String(S.i18n).match(re) || [];
    if (hits.length !== 2) bad.push('字典键 `' + k + '` 应出现 2 次（中/英），实际 ' + hits.length);
  });

  // ── ⑨ 旧路已经删干净（`design/0082` §2.1：`⌘N` 与"目录里新建"解耦） ──
  if (/'fail\.new\.no-directory'/.test(main)) bad.push('`fail.new.no-directory` 那一支还在（先建后存之后不存在"没有目录"这个失败）');
  if (/window\.rmd\.newFile|services\/newfile\.js/.test(main)) {
    bad.push('`main.js` 还引用着已删除的 `services/newfile.js`（加载期会取到 undefined ⇒ 整窗空白）');
  }

  return bad;
}

test('源码级接线：基线全绿', function () {
  assert.deepStrictEqual(score(RAW), [], score(RAW).join('\n'));
});

// ────────────────────────────────────────────────────────────────
// 变异自测（⚠️ 没有这一步，"全绿"不说明判据真的在看）
// ────────────────────────────────────────────────────────────────

test('⭐ 变异自测：十二处写坏各必须让**对应**判据变红', function () {
  assert.deepStrictEqual(score(RAW), [], '基线必须先全绿，否则下面分不清是谁的红');
  const with_ = function (patch) { return Object.assign({}, RAW, patch); };
  const hit = function (bad, needle) {
    return bad.some(function (x) { return x.indexOf(needle) >= 0; });
  };
  const m = function (patch, needle) {
    const bad = score(with_(patch));
    assert.ok(hit(bad, needle), '变异没有被打红：' + needle + '\n实际：' + bad.join('\n'));
  };

  // 1. `⌘N` 丢脏闸 ⇒ 静默丢字
  m({ main: RAW.main.replace('if (!(await gateSwitchDoc(name, onNewFile))) return;', '') },
    '没有先过 `gateSwitchDoc`');

  // 2. `⌘N` 又去建文件（先建后存的语义整个反了）
  m({ main: RAW.main.replace('out = await S.newUntitled();', "out = await T.call('create_entry', {});") },
    '又去建文件了');

  // 3. 面板取消被当成已保存
  m({ main: RAW.main.replace('if (!out) return { cancelled: true };', 'if (!out) return { written: true };') },
    '面板被取消');

  // 4. 分栏保存不分流（草稿走 `save_document` ⇒ 后端没有可写的文档）
  m({ main: RAW.main.replace('return isDraftDoc() ? saveDraft(text) : S.saveDocument(text, ++editReqSeq);',
    'return S.saveDocument(text, ++editReqSeq);') },
    '没有按 `isDraftDoc()` 分流');

  // 5. 脏闸把取消当继续（`promptLeaveEdit`）
  m({ main: RAW.main.replace('if (out && out.cancelled) return;', '') },
    '`promptLeaveEdit` 不认 `{cancelled:true}`');

  // 6. `save.js` 在清脏之前没拦取消
  m({ save: RAW.save.replace('if (out && out.cancelled) {', 'if (false) {') },
    '`editor/save.js` 不认 `{cancelled:true}`');

  // 7. 身份里丢了 `draft`（草稿的 `realPath` 是空串，与"没有文档"分不开）
  m({ live: RAW.live.replace('draft: (p && p.draft) || null,', '') },
    '没有把 `draft` 放进身份');

  // 8. 关窗守卫不拦（"取消 = 真的不关"退化成"取消也关"）
  m({ main: RAW.main.replace('event.preventDefault();', '') },
    '没有 `preventDefault`');

  // 9. 关窗守卫把"不脏"也拦了 ⇒ 挂上监听之后窗口永远关不掉
  m({ main: RAW.main.replace('if (!hasUnsavedChanges()) return;', '') },
    '没有"不脏就放行"');

  // 10. 取消之后仍然关窗（用户在面板里点了取消，字被关掉）
  m({ main: RAW.main.replace('if (!out || out.cancelled) return;', 'if (!out) return;') },
    '在取消 / 失败时仍会关窗');

  // 11. ACL 漏了 destroy ⇒ 窗口关不掉
  m({ caps: RAW.caps.replace(',\n    "core:window:allow-destroy"', '') },
    '没有 `core:window:allow-destroy`');

  // 12. 就地编辑保存后不回填身份 ⇒ 下一次 `begin_edit` 拿新路径比旧空串
  m({ live: RAW.live.replace('if (ident0.draft && saved && saved.path) {', 'if (false) {') },
    '没有回填身份');
});
