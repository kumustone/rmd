// 命令清单的**集合级**一致性闸门（`docs/backlog.md` B-11）。
//
// ⭐ 为什么需要这一条：一个 Tauri 命令至少要出现在三处「清单」里——
//    ① `src-tauri/build.rs` 的 `AppManifest::commands(&[…])`（决定 ACL manifest）
//    ② `src-tauri/src/gui/mod.rs` 的 `tauri::generate_handler![…]`（注册进 IPC）
//    ③ `src-tauri/capabilities/default.json` 的 `permissions`（`allow-x-y`）
//    漏任何一处的表现都是**功能无反应、日志无异常**：ACL 会**静默拒** `invoke`，
//    前端只拿到一个 `Err`，而后端函数体一行都不跑（`docs/bugs/0002`、`docs/kb/0007`）。
//    既有 js 闸门都是**点状**断言（某条命令在不在），没有「三处集合完全相等」的
//    全局判据 ⇒ 新增命令时漏改一处，今天没有任何东西会红。
//
// ⚠️ 三份清单都是**现读**：⛔ 不在本文件里抄第三份副本——那会把被测对象换成副本，
//    闸门就只证明「副本和副本相等」了。⚠️ 代价是解析器会随 Rust/JSON 格式变化而
//    **静默少读**（少读 = 假绿）⇒ 每个解析器都配了自检：条数下限 ＋ 必含已知命令；
//    风格照 `tests/js/keymap-forward.test.js` 的 `读真表()`。
//
// ⚠️ 名字形状**三处不同**（`docs/kb/0007` 记下的坑）：
//    `build.rs` 与 `generate_handler!` 是 **snake_case 函数名**，capabilities 是
//    **kebab 的权限 id**（`set_sidebar_width` ↔ `allow-set-sidebar-width`）。
//    ⇒ 比较前统一折成 snake_case。
//
// ⚠️ 纯逻辑、只读源码、无 DOM/无 IPC ⇒ 可 `node --test`。

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const BUILD_RS = path.join(ROOT, 'src-tauri', 'build.rs');
const GUI_MOD_RS = path.join(ROOT, 'src-tauri', 'src', 'gui', 'mod.rs');
const CAPABILITIES_JSON = path.join(ROOT, 'src-tauri', 'capabilities', 'default.json');

// ─────────────────────────────────────────────────────────────────────────
// 解析工具
// ─────────────────────────────────────────────────────────────────────────

/**
 * 去掉 Rust 的 `//` / `/* … *​/` 注释，但**保留字符串字面量内部的内容**。
 *
 * ⚠️ 为什么不能直接 `replace(/\/\/.*$/gm, '')`：build.rs 的注释里**含 ASCII 双引号**
 *    （例如「表现是"窗口不换文档"」）。注释没先去掉的话，下面按 `"…"` 抽命令名会
 *    把**注释里的中文短语**当成命令读进来——多读同样会让集合比较失去意义。
 * ⚠️ 字符串分支必须在注释分支之前生效，否则 `"http://…"` 里的 `//` 会被误删；
 *    这里用一个字符一个字符的扫描保证顺序。
 *
 * @param {string} 源码
 * @returns {string}
 */
function 去Rust注释(源码) {
  let out = '';
  let i = 0;
  while (i < 源码.length) {
    const c = 源码[i];
    const n = 源码[i + 1];

    if (c === '/' && n === '/') {
      // 行注释：跳到行尾（保留换行，方便下面按行定位）。
      const 行尾 = 源码.indexOf('\n', i);
      if (行尾 < 0) break;
      i = 行尾;
    } else if (c === '/' && n === '*') {
      // 块注释：Rust 允许嵌套。
      i += 2;
      let 深度 = 1;
      while (i < 源码.length && 深度 > 0) {
        if (源码[i] === '/' && 源码[i + 1] === '*') {
          深度 += 1;
          i += 2;
        } else if (源码[i] === '*' && 源码[i + 1] === '/') {
          深度 -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
    } else if (c === '"') {
      // 字符串字面量：原样保留（含转义）。
      out += c;
      i += 1;
      while (i < 源码.length) {
        if (源码[i] === '\\') {
          out += 源码[i] + (源码[i + 1] || '');
          i += 2;
        } else if (源码[i] === '"') {
          out += 源码[i];
          i += 1;
          break;
        } else {
          out += 源码[i];
          i += 1;
        }
      }
    } else if (c === "'" && (源码[i + 1] === '\\' || 源码[i + 2] === "'")) {
      // 字符字面量（`'/'` 之类）。⚠️ 只认"闭合的字符字面量"，否则生命周期 `'a` 会被吃掉。
      out += c;
      i += 1;
      while (i < 源码.length) {
        if (源码[i] === '\\') {
          out += 源码[i] + (源码[i + 1] || '');
          i += 2;
        } else if (源码[i] === "'") {
          out += 源码[i];
          i += 1;
          break;
        } else {
          out += 源码[i];
          i += 1;
        }
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** 命令名的合法形状（三处统一折成 snake_case 之后）。 */
const 命令名 = /^[a-z][a-z0-9_]*$/;

/**
 * 断言一条清单的项数下限与锚点命令。
 * ⚠️ 这是**解析自检**，⛔ 不是产品契约：它的唯一职责是挡住「格式一变就少读、假绿」。
 *    下限取 30（当前 38），留出正常增删的余量；锚点选三条**跨模块、长期存在**的命令
 *    （`read_asset` 在 asset 模块、`save_document` 在 edit 模块、`get_session` 在
 *    commands 模块）⇒ 解析器只认某一种写法时会当场露馅。
 *
 * @param {string} 处
 * @param {string[]} 名单
 */
function 自检(处, 名单) {
  assert.ok(
    名单.length >= 30,
    '⛔ 从 ' + 处 + ' 只读到 ' + 名单.length + ' 条命令 —— 解析器跟不上格式了，' +
      '别把这个数当成"命令变少了"（少读 = 假绿，这正是本闸门最怕的失败形态）'
  );
  ['get_session', 'read_asset', 'save_document'].forEach(function (锚) {
    assert.ok(
      名单.indexOf(锚) >= 0,
      '⛔ 从 ' + 处 + ' 读不到锚点命令 `' + 锚 + '` —— 解析出来的显然不是那份清单'
    );
  });
}

/**
 * 读 `build.rs` 的 `AppManifest::commands(&[…])`。
 *
 * ⭐ 这里的每一项都直接决定 ACL manifest：漏一条 = 该命令被**静默拒**。
 * @returns {string[]}
 */
function 读build清单() {
  const 全文 = 去Rust注释(fs.readFileSync(BUILD_RS, 'utf8'));
  const 开头 = 'AppManifest::new().commands(&[';
  const 起 = 全文.indexOf(开头);
  assert.ok(起 >= 0, '⛔ `build.rs` 里找不到 `' + 开头 + '` —— 清单换了写法，本测试的输入已经变了');
  const 止 = 全文.indexOf('])', 起 + 开头.length);
  assert.ok(止 > 起, '⛔ `build.rs` 里找不到 `commands(&[…])` 的结尾 `])`');
  const 段 = 全文.slice(起 + 开头.length, 止);

  const 名单 = [];
  const 字面量 = /"([^"]+)"/g;
  let m;
  while ((m = 字面量.exec(段)) !== null) {
    assert.match(
      m[1],
      命令名,
      '⛔ `build.rs` 的 commands 里读到一个不像命令名的串：' + JSON.stringify(m[1])
    );
    名单.push(m[1]);
  }
  自检('build.rs 的 commands', 名单);
  return 名单;
}

/**
 * 读 `gui/mod.rs` 的 `tauri::generate_handler![…]`。
 *
 * ⭐ 这一处决定命令有没有**注册进 IPC**：漏一条 = 前端 `invoke` 直接报
 *    "command not found"（比 ACL 静默拒稍响，但同样是功能不可用）。
 * ⚠️ 项可以是裸名（`set_language`）也可以是路径（`commands::get_session`）
 *    ——统一取最后一段标识符。
 * @returns {string[]}
 */
function 读gui清单() {
  const 全文 = 去Rust注释(fs.readFileSync(GUI_MOD_RS, 'utf8'));
  const 开头 = 'tauri::generate_handler![';
  const 起 = 全文.indexOf(开头);
  assert.ok(起 >= 0, '⛔ `gui/mod.rs` 里找不到 `' + 开头 + '` —— 注册清单换了写法，本测试的输入已经变了');
  const 止 = 全文.indexOf(']', 起 + 开头.length);
  assert.ok(止 > 起, '⛔ `gui/mod.rs` 里找不到 `generate_handler![…]` 的结尾 `]`');
  const 段 = 全文.slice(起 + 开头.length, 止);

  const 名单 = 段
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean)
    .map(function (项, i) {
      // ⚠️ 只接受「(模块::)*标识符」：格式一变（嵌套宏、属性、元组）就**当场报错**，
      //    不静默跳过——静默跳过一条就等于把一条命令从闸门里摘出去。
      const m = /^(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Za-z_][A-Za-z0-9_]*)$/.exec(项);
      assert.ok(
        m,
        '⛔ `generate_handler!` 第 ' + (i + 1) + ' 项解析不出命令名：' + JSON.stringify(项)
      );
      return m[1];
    });

  自检('gui/mod.rs 的 generate_handler!', 名单);
  return 名单;
}

/**
 * 读 `capabilities/default.json` 里的 `allow-*` 权限，折成 snake_case 命令名。
 *
 * ⭐ 这一处决定 ACL 是否放行：漏一条 = 静默拒（本闸门存在的主因）。
 * ⚠️ 同一数组里还有 `core:event:allow-listen` 这类**插件权限**（形状带 `:`），
 *    它们不是自有命令 ⇒ 只取 `allow-` 前缀项；自检会反向确认 core 项**确实存在**，
 *    防止哪天数组结构变了、过滤器把整个清单读成空。
 * @returns {string[]}
 */
function 读capabilities清单() {
  const 原始 = JSON.parse(fs.readFileSync(CAPABILITIES_JSON, 'utf8'));
  assert.ok(Array.isArray(原始.permissions), '⛔ `capabilities/default.json` 的 `permissions` 不是数组');
  assert.ok(
    原始.permissions.some(function (p) { return typeof p === 'string' && p.indexOf('core:') === 0; }),
    '⛔ `permissions` 里一条 `core:` 项都没有 —— 读到的大概不是那份真清单'
  );

  const 名单 = 原始.permissions
    .filter(function (p) { return typeof p === 'string' && p.indexOf('allow-') === 0; })
    .map(function (p) { return p.slice('allow-'.length).replace(/-/g, '_'); });

  名单.forEach(function (名) {
    assert.match(名, 命令名, '⛔ capabilities 里折出来的名字不像命令名：' + JSON.stringify(名));
  });
  自检('capabilities/default.json 的 allow-*', 名单);
  return 名单;
}

const 清单 = {
  build: 读build清单(),
  gui: 读gui清单(),
  caps: 读capabilities清单(),
};

// ─────────────────────────────────────────────────────────────────────────
// 已知偏差允许清单（B-11 的临时出口）
// ─────────────────────────────────────────────────────────────────────────
//
// ⚠️ 结构：`{ command: 'snake_case 命令名', 缺于: ['gui', 'caps'] }`。
//    `缺于` 里只能写 `build` / `gui` / `caps`。
// ⚠️ 登记进来的命令会在集合比较中**整体豁免** ⇒ 只有「已确认、已在 B-11 挂账」的
//    偏差才准进来；新增偏差必须打红，⛔ 不许用它把闸门调绿。
// ⚠️ 修好一条就删一条：下面「允许清单没有过期项」那条会对着真清单复核。
// ✅ 2026-11-11 首次落地时实读：三处均为 38 条且互差为空 ⇒ 本清单为空。
//    留结构而不是删掉它，是为了下一次发现偏差时有唯一、显式、可消失的落点。
//
// TODO(B-11): 发现偏差时逐条登记于此，并在报告/backlog 里写明「命令名 + 缺于哪几处」。
const 已知偏差 = [
  // 示例（⛔ 不要取消注释，除非真的存在这条偏差）：
  // { command: 'some_command', 缺于: ['caps'] },
];

const 豁免名 = new Set(已知偏差.map(function (d) { return d.command; }));

/**
 * 取一条清单的有效集合（去掉已登记的已知偏差）。
 * @param {'build'|'gui'|'caps'} 处
 * @returns {string[]}
 */
function 有效(处) {
  return 清单[处].filter(function (x) { return !豁免名.has(x); }).sort();
}

/**
 * 一条断言一个方向：打印「只在 A 不在 B」与「只在 B 不在 A」两份差集。
 *
 * ⚠️ 为什么拆成两条而不是 `deepStrictEqual(A, B)`：合成的失败只告诉你"两边不等"，
 *    而这里最需要的信息是**方向**——「build 有、caps 没有」意味着 ACL 会静默拒，
 *    「caps 有、gui 没有」意味着权限声明了一条根本没注册的命令。方向不同，修法不同。
 *
 * @param {'build'|'gui'|'caps'} A
 * @param {'build'|'gui'|'caps'} B
 */
function 断言两向相等(A, B) {
  const a = 有效(A);
  const b = 有效(B);
  const a集 = new Set(a);
  const b集 = new Set(b);
  const 只在A = a.filter(function (x) { return !b集.has(x); });
  const 只在B = b.filter(function (x) { return !a集.has(x); });

  assert.deepStrictEqual(
    只在A,
    [],
    '⛔ 只在 ' + A + '、不在 ' + B + ' 的命令：' + JSON.stringify(只在A) +
      ' —— 这几条在 ' + B + ' 那侧会被 ACL 静默拒 / 未注册，表现是"功能无反应、日志无异常"'
  );
  assert.deepStrictEqual(
    只在B,
    [],
    '⛔ 只在 ' + B + '、不在 ' + A + ' 的命令：' + JSON.stringify(只在B) +
      ' —— 这几条在 ' + A + ' 那侧没有对应声明，集合已经不相等'
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 解析自检（保证下面几条"相等"不是拿空集/残集比出来的）
// ─────────────────────────────────────────────────────────────────────────

test('解析自检：三份清单都读到了完整量级，且没有重复项', function () {
  // ⚠️ 单条断言不够：`自检()` 已经在每个解析器末尾跑过（条数下限 ＋ 三个锚点），
  //    这里再补一条**跨处的量级一致性**与重复项检查——
  //    重复项会让集合比较"看起来相等"（Set 会去重），但真实的 IPC 注册/ACL 列表是数组。
  ['build', 'gui', 'caps'].forEach(function (处) {
    const 重复 = 清单[处].filter(function (x, i) { return 清单[处].indexOf(x) !== i; });
    assert.deepStrictEqual(重复, [], '⛔ ' + 处 + ' 清单里有重复项：' + JSON.stringify(重复));
  });
  assert.ok(
    清单.build.length >= 30 && 清单.gui.length >= 30 && 清单.caps.length >= 30,
    '⛔ 三份清单的量级不一致或偏小：build=' + 清单.build.length +
      ' gui=' + 清单.gui.length + ' caps=' + 清单.caps.length
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 集合相等（三对、每对两个方向）
// ─────────────────────────────────────────────────────────────────────────

test('⭐ build.rs 的 commands 与 gui/mod.rs 的 generate_handler 集合相等', function () {
  // ⭐ 承重理由：build.rs 决定 ACL manifest、generate_handler 决定 IPC 注册；
  //    两边差一条 = 前端调用了「有权限但没注册」或「注册了但没权限」的命令。
  断言两向相等('build', 'gui');
});

test('⭐ gui/mod.rs 的 generate_handler 与 capabilities 集合相等', function () {
  // ⭐ 承重理由：这是 `bugs/0002` 的原始形态——命令注册了、权限没声明，
  //    ACL 静默拒，界面上只表现为"点了没反应"。
  断言两向相等('gui', 'caps');
});

test('⭐ capabilities 与 build.rs 的 commands 集合相等', function () {
  // ⭐ 承重理由：这份「绕一圈」的比较与上两条不是重复，而是**独立的方向**：
  //    它能抓住「build.rs 与 capabilities 同错、只有 generate_handler 是对的」这种
  //    两两比较看不出来的三角偏差（例如两次改动分别漏了不同的一处）。
  断言两向相等('caps', 'build');
});

test('已知偏差允许清单没有过期项（修好一条就必须删一条）', function () {
  // ⚠️ 允许清单是**有生命周期的**：偏差修好之后如果还留在清单里，闸门会永久豁免
  //    那条命令，下一次它再漏就静默放行。⇒ 每次运行都对着真清单复核一遍。
  已知偏差.forEach(function (d) {
    assert.ok(
      d.缺于 && Array.isArray(d.缺于) && d.缺于.length > 0,
      '⛔ 已知偏差 `' + d.command + '` 没写 `缺于` —— 无法复核它是否仍然成立'
    );
    d.缺于.forEach(function (处) {
      assert.ok(
        清单[处],
        '⛔ 已知偏差 `' + d.command + '` 的 `缺于` 写了不存在的清单：' + 处
      );
      assert.ok(
        清单[处].indexOf(d.command) < 0,
        '⛔ 已知偏差 `' + d.command + '` 已不在 ' + 处 + ' 缺失 —— 偏差已修复，' +
          '请从允许清单里删掉这条登记（TODO(B-11)）'
      );
    });
    const 出现处 = ['build', 'gui', 'caps'].filter(function (处) {
      return 清单[处].indexOf(d.command) >= 0;
    });
    assert.ok(
      出现处.length > 0 && 出现处.length < 3,
      '⛔ 已知偏差 `' + d.command + '` 现在出现在 ' + JSON.stringify(出现处) +
        ' —— 它要么已经三处齐全（请删登记），要么三处都没有（这不是"偏差"，是死代码）'
    );
  });
});
