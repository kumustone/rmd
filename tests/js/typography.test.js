// `design/0046`（字阶、标题间距与三套主题的引用/表头配色，2026-10-25）的**源码级判据**。
//
// # 为什么这几条必须自动化
//
// 这里守的每一件事，**浏览器都不会报错**，而且都不是"打开看看"能看出来的：
//
//   ① **字阶塌成一条线**（h1/h2/h3 撞在一起）：视觉上只是"标题变小了"，
//      没人会想到是 CSS 里某个系数被改回去了；
//   ② **标题上方间距 > 下方间距**：这是 `0046` 之前的状态（1.2 vs 0.6），
//      改回 1.2 时页面只是"又有点松"，⛔ 不会红、不会报错；
//   ③ **正文链接过不了 AA**：`#3b82f6` 在白底上 3.68 : 1——"能看见"但**阅读吃力**。
//      对比度是**算得出来的**，不该靠目视。
//   ④ ⚠️ **只按一套底色调色**：本仓有 **light / dark / warm 三套底色**
//      （`#ffffff` / `#1e1e1e` / `#fdfaf3`）。同一个青色条在白色上好看、在三套里都成立，
//      才是"协调"；只对着白底挑完就交付，另外两套会**静默**变成一块糊掉的色块。
//      ⇒ 下面每一条颜色判据都**逐主题**跑，⛔ 不取平均、不只看 light。
//   ⑤ **引用条成了"半条黑杠"**：`0005` A7 的 10px 是配半透明条 + 淡底的卡片的；
//      换成实色条（0046）之后同一个宽度就成了视觉主体（14px 正文下 **8.75px**）——
//      改回去只会让页面"又变重了"，⛔ 不报错。
//
// ⚠️ 判据对**注释免疫**：本仓注释里大量写着"⛔ 别写成 X"，直接 grep 原文会把正确的注释判成缺陷
//    ⇒ 所有取数都在 `stripComments` 之后跑。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = function (p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); };

const RAW = {
  tokens: read('src/styles/tokens.css'),
  themes: read('src/styles/themes.css'),
  typography: read('src/styles/typography.css'),
};

/** 挖空 `/* … *\/`（保留换行）。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

const SRC = {
  tokens: stripComments(RAW.tokens),
  themes: stripComments(RAW.themes),
  typography: stripComments(RAW.typography),
};

// ────────────────────────────────────────────────────────────────
// 解析：`:root { … }` 与 `[data-theme="x"] { … }`
// ────────────────────────────────────────────────────────────────

/** 取一个块里的变量声明表；`selector === null` 取文件里第一个 `:root`。 */
function vars(src, selector) {
  const out = {};
  const at = selector ? src.indexOf(selector) : src.indexOf(':root');
  assert.ok(at >= 0, '找不到 ' + (selector || ':root'));
  const open = src.indexOf('{', at);
  const close = src.indexOf('}', open);
  collect(src.slice(open + 1, close), out);
  return out;
}

function collect(block, out) {
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(block))) out[m[1]] = m[2].trim();
}

/** 顺着 `var(--x)` 解到具体值；主题块里没有就回落到 `:root`（CSS 的层叠顺序）。 */
function resolve(table, root, name, depth) {
  const d = depth || 0;
  if (d > 8) throw new Error('var() 解析成环：' + name);
  let v = table[name];
  let scope = table;
  if (v === undefined) { v = root[name]; scope = root; }
  if (v === undefined) return undefined;
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (!m) return v;
  return resolve(scope, root, m[1], d + 1);
}

/** `#rrggbb` → 相对亮度（WCAG 2.x）。 */
function lum(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  assert.ok(m, '不是 #rrggbb：' + hex);
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** 两色的对比度。 */
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 三套主题的取数表（`:root` 即 light）。 */
function themes(s) {
  const root = vars(s.tokens, null);
  return [
    { name: 'light', table: root, root: root },
    { name: 'dark', table: vars(s.themes, '[data-theme="dark"]'), root: root },
    { name: 'warm', table: vars(s.themes, '[data-theme="warm"]'), root: root },
  ];
}

/** 取某主题里某变量的**解析后**值。 */
function value(t, name) {
  return resolve(t.table, t.root, name);
}

// ────────────────────────────────────────────────────────────────
// 判据
// ────────────────────────────────────────────────────────────────

/**
 * @param {{tokens:string,themes:string,typography:string}} s 已剥注释的源码
 * @returns {string[]} 失败项（空 = 全过）
 */
function score(s) {
  const bad = [];
  const root = vars(s.tokens, null);

  // ── ① 字阶：严格递减，且 ⛔ 不许回到"标题比正文大两倍多" ──
  const scales = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(function (k) {
    const v = root['--reader-scale-' + k];
    if (v === undefined) bad.push('tokens.css 少了 --reader-scale-' + k);
    return parseFloat(v);
  });
  for (let i = 1; i < scales.length; i++) {
    if (!(scales[i - 1] > scales[i])) {
      bad.push('字阶不是严格递减：h' + i + ' ' + scales[i - 1] + ' ≯ h' + (i + 1) + ' ' + scales[i]);
    }
  }
  if (!(scales[0] <= 2.2)) {
    bad.push('h1 = ' + scales[0] + '×（0046 定的是 2.00；>2.2 就是那条"标题太跳"的老路）');
  }
  if (!(scales[1] >= 1.6 && scales[1] <= 1.9)) {
    bad.push('h2 = ' + scales[1] + '×（0046 定的是 1.75，实测对标 Mardo 的 1.79×）');
  }
  if (!(scales[2] >= 1.35 && scales[2] <= 1.55)) {
    bad.push('h3 = ' + scales[2] + '×（0046 定的是 1.45，实测对标 Mardo 的 1.43×）');
  }

  // ── ② 尺度仍由**唯一锚点**派生（`INV-TYPE-02`）：⛔ 不许出现 px ──
  ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'small'].forEach(function (k) {
    const v = root['--reader-size-' + k] || '';
    if (!/calc\(\s*var\(--reader-font-size\)\s*\*\s*var\(--reader-scale-/.test(v)) {
      bad.push('--reader-size-' + k + ' 不是「锚点 × 系数」派生的：' + v);
    }
    if (/px\b/.test(v)) bad.push('--reader-size-' + k + ' 里出现了绝对 px（INV-TYPE-02）：' + v);
  });

  // ── ③ 标题间距：**上方必须小于下方**（0046 的唯一裁决）──
  const before = parseFloat(root['--reader-gap-heading-before']);
  const after = parseFloat(root['--reader-gap-heading-after']);
  if (!(before < after)) {
    bad.push('标题上/下间距 ' + before + ' / ' + after + ' —— 0046 要求**上方小于下方**' +
      '（改回 1.2 时页面只是"又有点松"，浏览器不会报任何东西）');
  }
  const block = root['--reader-gap-block'] || '';
  if (/px\b/.test(block) || !/var\(--reader-font-size\)/.test(block)) {
    bad.push('--reader-gap-block 没有跟着锚点派生：' + block);
  }

  // ── ④ 正文字与标题的**色板出处**（`INV-THEME-02` 的定点加密）──
  if (!/^var\(--p-[a-z]+-\d+\)$/.test(root['--reader-link'] || '')) {
    bad.push(':root 的 --reader-link 没有走色板变量：' + root['--reader-link']);
  }

  const ts = themes(s);

  // ── ⑤ 正文链接：**三套主题各自**过 AA（4.5 : 1）──
  ts.forEach(function (t) {
    const link = value(t, '--reader-link');
    const bg = value(t, '--reader-bg');
    if (!link || !bg) { bad.push(t.name + ' 取不到 --reader-link / --reader-bg'); return; }
    if (!/^#[0-9a-f]{6}$/i.test(link)) { bad.push(t.name + ' 的链接色不是 #rrggbb：' + link); return; }
    const c = contrast(link, bg);
    if (!(c >= 4.5)) {
      bad.push(t.name + ' 的正文链接对比度 ' + c.toFixed(2) + ' : 1 < 4.5（AA 正文线）：' + link + ' / ' + bg);
    }
  });

  // ── ⑥ 引用块的**形态**：只有一条实色竖条，⛔ 不填底色（`0046` 取代 `0005` A7）──
  ts.forEach(function (t) {
    const qbg = value(t, '--reader-quote-bg');
    if (qbg !== 'transparent') {
      bad.push(t.name + ' 的 --reader-quote-bg 是 ' + qbg +
        '（0046 起引用块不填底色，只留竖条）；⚠️ 与 0005 A7 的填底形态相冲突');
    }
  });

  // ── ⑦ 引用条：三套主题都要**非文字可辨**（WCAG 1.4.11 的 3 : 1）──
  ts.forEach(function (t) {
    const bar = value(t, '--reader-quote-bar-color');
    const bg = value(t, '--reader-bg');
    if (!/^#[0-9a-f]{6}$/i.test(bar || '')) {
      bad.push(t.name + ' 的引用条不是**实色**（0046 起不透明；半透明会让它在三套底色上浓淡不一）：' + bar);
      return;
    }
    const c = contrast(bar, bg);
    if (!(c >= 3)) {
      bad.push(t.name + ' 的引用条对比度 ' + c.toFixed(2) + ' : 1 < 3（非文字图形线）：' + bar + ' / ' + bg);
    }
  });

  // ── ⑧ 表头底色：三套主题都要**字仍可读**且**与页面底分得开** ──
  ts.forEach(function (t) {
    const head = value(t, '--reader-table-head-bg');
    const bg = value(t, '--reader-bg');
    const text = value(t, '--reader-text');
    if (!/^#[0-9a-f]{6}$/i.test(head || '')) {
      bad.push(t.name + ' 的 --reader-table-head-bg 不是 #rrggbb：' + head);
      return;
    }
    const cText = contrast(text, head);
    if (!(cText >= 4.5)) {
      bad.push(t.name + ' 的表头「字/底」' + cText.toFixed(2) + ' : 1 < 4.5（表头也是正文级文字）：' +
        text + ' / ' + head);
    }
    const cBg = contrast(head, bg);
    if (!(cBg >= 1.08)) {
      bad.push(t.name + ' 的表头底色与页面底分不开（' + cBg.toFixed(2) + ' : 1）：' + head + ' / ' + bg);
    }
  });

  // ── ⑨ 新变量必须真被引用，⛔ 不许"定义了没人用" ──
  if (!/background\s*:\s*var\(--reader-table-head-bg\)/.test(s.typography)) {
    bad.push('typography.css 里没有任何规则引用 --reader-table-head-bg（定义了没人用 = 表头不会变色）');
  }

  // ── ⑩ 引用条的**宽度**：实色条形态下不许再是"半条黑杠" ──
  // ⚠️ 这条守的是 2026-10-25 用户的第二次点题（「这个绿色的竖线，太粗了」）：
  //    `0.625` 在 14px 正文下是 **8.75px**——`0005` A7 那会儿它配的是**半透明条 + 淡底**的卡片，
  //    粗细只是"标出范围"；`0046` 换成**实色条 + 不填底**之后，同一个宽度就成了视觉主体。
  //    改回 10px **不会报错**，页面只是"又变重了"。
  const barW = root['--reader-quote-bar-width'] || '';
  if (!/calc\(\s*var\(--reader-font-size\)\s*\*\s*var\(--reader-quote-bar-factor\)\s*\)/.test(barW)) {
    bad.push('--reader-quote-bar-width 不是「锚点 × 系数」派生的（INV-TYPE-02）：' + barW);
  }
  const barFactor = parseFloat(root['--reader-quote-bar-factor']);
  if (!(barFactor > 0 && barFactor <= 0.3)) {
    bad.push('引用条系数 = ' + root['--reader-quote-bar-factor'] +
      '（0046 定的是 0.2857 ⇒ 14px 正文下 4px；> 0.3 就是那条"竖线比字还抢眼"的老路）');
  }

  return bad;
}

test('⭐ 产品样式满足 `design/0046` 的全部判据', function () {
  const bad = score(SRC);
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

test('⭐ 三套主题的现值（算出来的不是感觉）', function () {
  const rows = themes(SRC).map(function (t) {
    const bg = value(t, '--reader-bg');
    return [
      t.name,
      'link ' + value(t, '--reader-link') + ' ' + contrast(value(t, '--reader-link'), bg).toFixed(2),
      'bar ' + value(t, '--reader-quote-bar-color') + ' ' + contrast(value(t, '--reader-quote-bar-color'), bg).toFixed(2),
      'head ' + value(t, '--reader-table-head-bg') + ' 字/底 ' +
        contrast(value(t, '--reader-text'), value(t, '--reader-table-head-bg')).toFixed(2),
    ].join(' | ');
  });
  // ⚠️ 只做记录（`node --test` 默认不打印通过的 info）——真正判红的是上面那条
  assert.strictEqual(rows.length, 3, rows.join('\n'));
});

// ────────────────────────────────────────────────────────────────
// 变异自测（⚠️ 没有这一步，"全绿"不说明判据真的在看）
// ────────────────────────────────────────────────────────────────

test('⭐ 变异自测：十一处写坏各必须让**对应**判据变红', function () {
  assert.deepStrictEqual(score(SRC), [], '基线必须先全绿，否则下面分不清是谁的红');
  const with_ = function (patch) { return Object.assign({}, SRC, patch); };
  const has = function (list, needle) { return list.some(function (x) { return x.indexOf(needle) >= 0; }); };

  /**
   * 改掉第 `n` 处声明的值。
   * ⚠️ 用正则、⛔ 不用字面串：声明之间的对齐空格是排版噪音，
   *    一旦写成字面串，改一次对齐就会让**变异悄悄失效**（"没改到"），
   *    而它的表现与"判据不敏感"一模一样。
   * ⚠️ 同时要求命中数够用——本仓铁律：改不到 ⇒ 按"没改到"处理，不是"没红就没事"。
   */
  const setDecl = function (src, name, value, n) {
    const re = new RegExp('(' + name + '\\s*:\\s*)[^;]+;', 'g');
    const idx = n || 0;
    const hits = src.match(re) || [];
    assert.ok(hits.length > idx, name + ' 只命中 ' + hits.length + ' 处，取不到第 ' + (idx + 1) + ' 处');
    let i = 0;
    return src.replace(re, function (m, prefix) {
      const mine = (i === idx);
      i += 1;
      return mine ? prefix + value + ';' : m;
    });
  };

  // 变异 1：h1 回到 2.60（用户 2026-10-25 说的那条"标题太跳"）
  const m1 = score(with_({ tokens: setDecl(SRC.tokens, '--reader-scale-h1', '2.60') }));
  assert.ok(has(m1, 'h1 ='), m1.join('\n'));

  // 变异 2：h2 被压成 h3 的系数（字阶撞在一起）
  const m2 = score(with_({ tokens: setDecl(SRC.tokens, '--reader-scale-h2', '1.45') }));
  assert.ok(has(m2, '严格递减'), m2.join('\n'));

  // 变异 3：标题上间距回到 1.2（页面只是"又有点松"，没有任何报错）
  const m3 = score(with_({ tokens: setDecl(SRC.tokens, '--reader-gap-heading-before', '1.2') }));
  assert.ok(has(m3, '上方小于下方'), m3.join('\n'));

  // 变异 4：链接回到 #3b82f6（3.68 : 1，过不了 AA）
  const m4 = score(with_({ tokens: setDecl(SRC.tokens, '--reader-link', 'var(--p-blue-500)') }));
  assert.ok(has(m4, '对比度'), m4.join('\n'));

  // 变异 5：某一级标题改成写死 px（`INV-TYPE-02`）
  const m5 = score(with_({ tokens: setDecl(SRC.tokens, '--reader-size-h3', '23px') }));
  assert.ok(has(m5, 'INV-TYPE-02'), m5.join('\n'));

  // 变异 6：暗色主题（`themes.css` 里第 1 处）的链接色换成一个过不了 AA 的值
  const m6 = score(with_({ themes: setDecl(SRC.themes, '--reader-link', '#3d6f9e', 0) }));
  assert.ok(has(m6, 'dark'), m6.join('\n'));

  // 变异 7：引用块填回底色（`0005` A7 的老形态）
  const m7 = score(with_({ tokens: setDecl(SRC.tokens, '--reader-quote-bg', '#f7f9fa') }));
  assert.ok(has(m7, '不填底色'), m7.join('\n'));

  // 变异 8：light 的引用条改回半透明（三套底色上浓淡不一）
  const m8 = score(with_({ tokens: setDecl(SRC.tokens, '--reader-quote-bar-color', 'rgba(102, 128, 153, 0.40)') }));
  assert.ok(has(m8, '实色'), m8.join('\n'));

  // 变异 9：warm（第 2 处）的表头底 == 页面底（定义了等于没定义）
  const m9 = score(with_({ themes: setDecl(SRC.themes, '--reader-table-head-bg', '#fdfaf3', 1) }));
  assert.ok(has(m9, '分不开'), m9.join('\n'));

  // 变异 10：dark（第 1 处）的表头底调到「深底深字」看不见的地步
  const m10 = score(with_({ themes: setDecl(SRC.themes, '--reader-table-head-bg', '#6a7074', 0) }));
  assert.ok(has(m10, '字/底'), m10.join('\n'));

  // 变异 11：引用条回到 10px（`0005` A7 的宽度）——实色条形态下就是"半条黑杠"
  const m11 = score(with_({ tokens: setDecl(SRC.tokens, '--reader-quote-bar-factor', '0.625') }));
  assert.ok(has(m11, '引用条系数'), m11.join('\n'));
});
