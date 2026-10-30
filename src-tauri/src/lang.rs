//! **界面语言的唯一裁定点**（`design/0025` §2.4，`INV-I18N-07`）。
//!
//! # 为什么单独一个模块
//!
//! 这份逻辑**⛔ 不能**放进 `gui/mod.rs`：那样它只在 `--features gui` 下编译，
//! 而 `make test` 跑的是**不带 gui** 的默认构建 ⇒ 这张真值表**一条测试也跑不到**
//! （与 `fs` / `error` / `config` / `external` 不门控是同一条理由，见 `main.rs` 的文件头）。
//! ⚠️ 菜单装配、`set_language` 命令那些**需要 `AppHandle` 的**接线仍然留在 `gui/mod.rs`，
//! 这里只有**纯逻辑 ＋ 一次只读的 spawn**。
//!
//! # 三档偏好，一个裁定点
//!
//! ```text
//! Config.language: "system" | "zh" | "en"（None == "system"）
//!        ├── "zh" / "en" ─────────→ 直接用（⛔ 不 spawn 任何东西）
//!        └── "system" / None ──→ system_language() ──→ /usr/bin/defaults read -g AppleLanguages
//! ```
//!
//! ⭐ **显式档绝不 spawn**：这不只是性能，是**可断言的行为**
//! （[`effective_with`] 在取系统语言**之前**就短路，测试传一个"被调用就 panic"的闭包即可证明）。
//!
//! # 为什么是 spawn `defaults` 而不是进程内 `NSLocale`
//!
//! 进程内读要引 ObjC FFI，而本项目**只有 `fs/order.rs` 一个 ObjC FFI 面**——
//! 为一次语言查询打开第二个面不划算（`design/0025` §2.4 末）。
//!
//! ⚠️ 代价是：`std::process::Command` **没有超时 API**，而这次 spawn 发生在
//! `install_menu`（**建窗口之前**）⇒ `cfprefsd` 卡住就会把 setup 卡死在那里。
//! 处置与 `design/0022` 同一手法：**`spawn()` ＋ 有界轮询 `try_wait()`，
//! 预算 [`SYSTEM_LANGUAGE_BUDGET_MS`]**（本机实测 20 次中位 **6.6 ms**、max 8.5 ms
//! ⇒ 200 ms 是 20× 余量），超时即 `kill` 并**按英文处理**。
//!
//! # 诚实的边界
//!
//! 读不出来、畸形、超时、没有这个二进制 —— **一律英文**。
//! ⛔ 不 panic、⛔ 不阻塞、⛔ 不猜"大概是中文吧"：
//! 回落到英文是**确定的一条**，而猜错的表现是"中文系统首启变成英文界面"——
//! 那正是 `features/0025` §3 第 1 条要防的（`design/0025` 评审 #2 就是按这条改的解析规则）。

// ⚠️ 默认构建（无 `gui`）里只有测试会用到这里的东西（`config` 只取 `normalize_language`）。
//    ⛔ 别为此把模块门控掉——门控等于"这条真值表没有测试"（见文件头）。
#![cfg_attr(not(any(feature = "gui", test)), allow(dead_code))]

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// 生效的界面语言。
///
/// ⚠️ **只有两种**——「跟随系统」是**偏好**（[`crate::config::LANGS`]），不是一种语言。
/// 这个区分承重：菜单与界面文案都只需要一个**确定**的答案。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
}

impl Lang {
    /// 线上形状 / 配置 / `init_script` 用的标签。
    ///
    /// ⚠️ 它**是**字典键空间的一部分（`services/i18n.js` 的 `DICT` 就是 `zh` / `en`），
    /// ⛔ 别在这里返回 `zh-CN` 那种带地区的形态——那会让前端查不到字典。
    /// （`<html lang>` 用的 `zh-CN` 是**另一件事**，只在前端写。）
    pub fn tag(self) -> &'static str {
        match self {
            Lang::Zh => "zh",
            Lang::En => "en",
        }
    }
}

/// 读系统语言用的二进制。⚠️ 绝对路径，⛔ 不从 `PATH` 里找。
pub const DEFAULTS_BIN: &str = "/usr/bin/defaults";

/// 这一次 spawn 的**总预算**（毫秒）。超时 ⇒ `kill` ⇒ [`Lang::En`]。
///
/// ⚠️ 数字有出处：本机 20 次实测中位 **6.6 ms**、max **8.5 ms**（`design/0025` 评审 #10）
/// ⇒ 200 ms 是 **20× 余量**。⛔ 别凭感觉改小——这条路径在**建窗口之前**。
pub const SYSTEM_LANGUAGE_BUDGET_MS: u64 = 200;

/// 显式档 → 语言；`"system"` / 认不出来的词 → `None`（"去问系统"）。
///
/// ⚠️ **归一化只有一份**：这里转调 [`crate::config::normalize_language`]，
/// ⛔ 不在这里另写一条 `match`——两份真值分叉的表现是
/// "设置里显示跟随系统、实际是英文界面"。
fn explicit(preference: &str) -> Option<Lang> {
    match crate::config::normalize_language(Some(preference)) {
        "zh" => Some(Lang::Zh),
        "en" => Some(Lang::En),
        _ => None,
    }
}

/// **纯函数**：`(偏好, 系统语言) → 生效语言`。
///
/// ⚠️ 系统语言是**入参**（⛔ 不在里面去 spawn）⇒ 真值表可以逐格断言。
pub fn resolve(preference: &str, system: Lang) -> Lang {
    explicit(preference).unwrap_or(system)
}

/// 同 [`resolve`]，但系统语言**惰性取**。
///
/// ⭐ **承重**：`"zh"` / `"en"` 在调用 `system` **之前**就返回
/// ⇒ 显式档**结构上不可能** spawn 任何东西。
/// 测试用一个"被调用就 panic / 置标记"的闭包即可证明这件事（⛔ 不需要假二进制、
/// ⛔ 不需要注入环境变量）。
pub fn effective_with(preference: &str, system: impl FnOnce() -> Lang) -> Lang {
    match explicit(preference) {
        Some(l) => l,
        None => system(),
    }
}

/// [`effective_with`] ＋ 真实的系统查询（带进程内缓存）。
pub fn effective(preference: &str) -> Lang {
    effective_with(preference, system_language)
}

/// 解析 `defaults read -g AppleLanguages` 的输出。**纯函数**。
///
/// 输入长这样（本机实测）：
///
/// ```text
/// (
///     "zh-Hans-CN"
/// )
/// ```
///
/// 规则（`design/0025` §2.4，⚠️ **2026-10-21 评审 #2 更正过**）：
/// **取第一个双引号串 → 按 `-` 切分取首段 → 首段是 `zh`（不区分大小写）⇒ 中文，否则英文**。
///
/// ⚠️⚠️ 原稿的"取第一个 `"xx-YY"` 形态的标签"在本机**解析不出来**——
/// 实测值是 **`zh-Hans-CN`**（**三段**）⇒ 按原规则算"畸形" ⇒ 回落英文
/// ⇒ **中文系统首启就是英文界面**。⛔ 别把切分规则"收紧"回去。
///
/// ⚠️ 空 / 没有双引号（单引号、裸词）/ 引号不配对 ⇒ 英文。⛔ 不 panic。
pub fn parse_apple_languages(text: &str) -> Lang {
    let Some(open) = text.find('"') else {
        return Lang::En;
    };
    let rest = &text[open + 1..];
    let Some(close) = rest.find('"') else {
        // ⚠️ 有开没闭 = 畸形。⛔ 别退回"把剩下全当标签"——那会把后面的括号一起吃进去。
        return Lang::En;
    };
    let tag = rest[..close].trim();
    if tag.is_empty() {
        return Lang::En;
    }
    let first = tag.split('-').next().unwrap_or("").trim();
    // ⚠️ 只认 `zh`：`zh-Hans-CN` / `zh-Hant-TW` / `zh` 全落这一支。
    //    ⛔ 别加"`cn` / `hans` 也算"的分支——那是给上面那条更正重新开一个口子。
    if first.eq_ignore_ascii_case("zh") {
        Lang::Zh
    } else {
        Lang::En
    }
}

/// 跑一次 `<bin> read -g AppleLanguages` 并解析，**用生产预算**（[`SYSTEM_LANGUAGE_BUDGET_MS`]）。
pub fn system_language_via(bin: &Path) -> Lang {
    system_language_within(bin, Duration::from_millis(SYSTEM_LANGUAGE_BUDGET_MS))
}

/// 跑一次 `<bin> read -g AppleLanguages` 并解析，**预算可传**。
///
/// `bin` 与 `budget` 都是参数而不是常量，**只为可测**：单测传自造脚本就能覆盖
/// 「正常输出 / 非零退出 / 卡住超时 / 二进制不存在」四条路，
/// ⛔ 不用去动本机的语言设置（那是改系统状态，本项目⛔ 不干）。
///
/// ⚠️ **这条命令是只读的**（`defaults read`）：⛔ 不改任何系统设置。
///
/// ⚠️ **为什么不会因为管道写满而死锁**：输出只有几十字节，远小于管道缓冲（64 KiB）；
/// 而且我们是**等子进程退出之后**才读 stdout。
///
/// ⚠️ **超预算的代价是"按英文处理"，这是刻意的**：`spawn` 发生在建窗口之前，
/// 让它无限等 ⇒ 一个卡住的 `cfprefsd` 能把整个应用卡死在启动那一刻。
/// 代价是**机器满载时中文系统可能首启拿到英文界面**（2026-10-21 实测过一次：
/// 230 条测试并行跑时，200 ms 内没轮到那个子进程）——
/// 这是"**有界降级**"换"**无界等待**"，⛔ 别为了消掉那一次抖动把预算改成无限。
pub fn system_language_within(bin: &Path, budget: Duration) -> Lang {
    let mut child = match Command::new(bin)
        .arg("read")
        .arg("-g")
        .arg("AppleLanguages")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        // ⚠️ 没有这个二进制（非 macOS / 被搬走）⇒ 英文。⛔ 不 panic。
        Err(_) => return Lang::En,
    };

    let deadline = Instant::now() + budget;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    // ⚠️ 先 kill 再 wait：⛔ 不留下一个还在跑的僵尸子进程
                    //    （`wait()` 顺手把僵尸收掉）。
                    let _ = child.kill();
                    let _ = child.wait();
                    return Lang::En;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Lang::En;
            }
        }
    }

    // ⚠️ 不判退出码：`defaults` 在"这个键不存在"时也可能给一段可解析的输出，
    //    而**能不能解析出 `zh`** 才是我们真正关心的判据（解析不出来本来就是英文）。
    let mut buf = String::new();
    match child.stdout.take() {
        Some(mut out) => {
            use std::io::Read;
            if out.read_to_string(&mut buf).is_err() {
                return Lang::En;
            }
        }
        None => return Lang::En,
    }
    let _ = child.wait();
    parse_apple_languages(&buf)
}

/// 系统语言，**进程内只问一次**。
///
/// ⚠️ 缓存的是 `&'static` 那一格：语言偏好是**登录会话级**的东西，
/// 用户在应用运行期间改系统语言的场景，重启应用即可（`design/0025` §6 的降级表）。
/// ⚠️ `OnceLock` 也让**多个调用点**（`setup` 里同时喂 `install_menu` 与 `init_script`）
/// 共享**同一个答案**——两份答案分叉的表现是"菜单中文、界面英文"。
pub fn system_language() -> Lang {
    static CACHE: OnceLock<Lang> = OnceLock::new();
    *CACHE.get_or_init(|| system_language_via(Path::new(DEFAULTS_BIN)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ────────────────────────────────────────────────────────────────
    // `resolve` 的真值表（`design/0025` §7.2 那一行）
    // ────────────────────────────────────────────────────────────────

    #[test]
    fn 显式档压过系统语言() {
        for (pref, sys, want) in [
            ("zh", Lang::Zh, Lang::Zh),
            ("zh", Lang::En, Lang::Zh),
            ("en", Lang::Zh, Lang::En),
            ("en", Lang::En, Lang::En),
            // ⚠️ 大小写与空白是**宽容**的——`config::normalize_language` 已归一，
            //    这里再钉一次是因为"两条路都归一"这件事**必须同时成立**。
            (" ZH ", Lang::En, Lang::Zh),
            ("En", Lang::Zh, Lang::En),
        ] {
            assert_eq!(resolve(pref, sys), want, "resolve({pref:?}, {sys:?})");
        }
    }

    #[test]
    fn 跟随系统与认不出来的词都去问系统() {
        for pref in ["system", "", "   ", "fr", "中文", "zh-CN", "en-US"] {
            assert_eq!(resolve(pref, Lang::Zh), Lang::Zh, "resolve({pref:?}, Zh)");
            assert_eq!(resolve(pref, Lang::En), Lang::En, "resolve({pref:?}, En)");
        }
    }

    #[test]
    fn 显式档不会去问系统() {
        // ⭐ **这是"`zh`/`en` 结构上不可能 spawn"的判据**：
        //    闭包被调用就 panic ⇒ 一旦短路写错（比如先取系统语言再判断），这条立刻红。
        // ⚠️ 用 panic 而不是置标记：标记写法在"闭包被调了但结果被丢弃"时**照样绿**。
        for pref in ["zh", "en", " ZH "] {
            let got = effective_with(pref, || panic!("显式档 {pref:?} 不该去问系统语言"));
            assert_eq!(got.tag(), if pref.trim().eq_ignore_ascii_case("zh") { "zh" } else { "en" });
        }
    }

    #[test]
    fn 跟随系统时会去问系统且只用那一次答案() {
        use std::cell::Cell;
        let calls = Cell::new(0);
        let got = effective_with("system", || {
            calls.set(calls.get() + 1);
            Lang::Zh
        });
        assert_eq!(got, Lang::Zh);
        assert_eq!(calls.get(), 1, "⛔ 跟随系统档必须恰好问一次");
    }

    // ────────────────────────────────────────────────────────────────
    // `parse_apple_languages` 的夹具（`design/0025` §2.4 点名那 7 类）
    // ────────────────────────────────────────────────────────────────

    #[test]
    fn 解析系统语言_三段标签也认() {
        // ⚠️ **这是评审 #2 那条更正的核心夹具**：本机实测值就是三段。
        //    ⛔ 别把它"简化"成 `zh-CN`——那样这条测试就守不住那个已经踩过的坑。
        assert_eq!(parse_apple_languages("(\n    \"zh-Hans-CN\"\n)\n"), Lang::Zh);
        assert_eq!(parse_apple_languages("(\n    \"zh-Hant-TW\"\n)\n"), Lang::Zh);
        assert_eq!(parse_apple_languages("(\"zh\")"), Lang::Zh);
    }

    #[test]
    fn 解析系统语言_英文与大小写() {
        assert_eq!(parse_apple_languages("(\n    \"en-US\"\n)\n"), Lang::En);
        assert_eq!(parse_apple_languages("(\"en\")"), Lang::En);
        assert_eq!(parse_apple_languages("(\"ZH-Hans-CN\")"), Lang::Zh);
        assert_eq!(parse_apple_languages("(\"EN-u-hc-h12\")"), Lang::En);
    }

    #[test]
    fn 解析系统语言_空与畸形一律英文() {
        // ⚠️ 这一组守的是"⛔ 不 panic、⛔ 不猜"：回落到英文是**确定的一条**。
        for 空 in ["", "   ", "()", "(\n)", "\n\n"] {
            assert_eq!(parse_apple_languages(空), Lang::En, "{空:?}");
        }
        // 单引号：不是 plist 的字符串形态 ⇒ 认不出来 ⇒ 英文。
        assert_eq!(parse_apple_languages("('zh-Hans-CN')"), Lang::En);
        // 有开没闭。
        assert_eq!(parse_apple_languages("(\"zh-Hans-CN)"), Lang::En);
        // 空标签。
        assert_eq!(parse_apple_languages("(\"\")"), Lang::En);
        // 认不出来的语言（法语）⇒ 英文（本应用只有两本字典）。
        assert_eq!(parse_apple_languages("(\"fr-FR\")"), Lang::En);
    }

    #[test]
    fn 解析系统语言_多语言取第一项() {
        // ⚠️ 这一条**是刻意的口径**：系统语言列表里中文排第二时，首项是英文
        //    ⇒ 界面英文。⛔ 别改成"列表里有中文就算中文"——
        //    那会让 `("en-US","zh-Hans-CN")` 的中英混排用户拿到中文界面，
        //    而 macOS 自己给他们的菜单是英文的。
        assert_eq!(parse_apple_languages("(\n    \"en-US\",\n    \"zh-Hans-CN\"\n)\n"), Lang::En);
        assert_eq!(parse_apple_languages("(\n    \"zh-Hans-CN\",\n    \"en-US\"\n)\n"), Lang::Zh);
    }

    // ────────────────────────────────────────────────────────────────
    // `system_language_via` 的四条路（⚠️ 用自造脚本，⛔ 不动本机设置）
    // ────────────────────────────────────────────────────────────────

    #[cfg(unix)]
    fn 假脚本(tag: &str, 内容: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("rmd-lang-{}-{tag}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        let p = d.join("fake-defaults.sh");
        std::fs::write(&p, 内容).unwrap();
        let mut perm = std::fs::metadata(&p).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&p, perm).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn 系统语言_正常输出走完整条管道() {
        // ⭐ 这条覆盖的是 `spawn → try_wait → 读 stdout → parse` 全链，
        //    ⛔ 不是又测一遍 `parse_apple_languages`。
        // ⚠️ **预算给到 5 s**（⛔ 不是生产那个 200 ms）：`cargo test` 并行跑两百多条测试，
        //    子进程 200 ms 内没被调度到是**真会发生的**（2026-10-21 实测红过一次）——
        //    那是"产品在有界降级"这条设计在满载下的表现，⛔ **不是产品的缺陷**。
        //    这条测试要判的是**管道通不通**，所以给它一个不会被调度抖动打中的预算。
        const 宽: Duration = Duration::from_secs(5);
        let p = 假脚本("zh", "#!/bin/sh\nprintf '(\\n    \"zh-Hans-CN\"\\n)\\n'\n");
        assert_eq!(system_language_within(&p, 宽), Lang::Zh);
        let p = 假脚本("en", "#!/bin/sh\nprintf '(\"en-US\")\\n'\n");
        assert_eq!(system_language_within(&p, 宽), Lang::En);
    }

    #[cfg(unix)]
    #[test]
    fn 系统语言_非零退出且没有输出时是英文() {
        let p = 假脚本("fail", "#!/bin/sh\nexit 1\n");
        assert_eq!(system_language_within(&p, Duration::from_secs(5)), Lang::En);
    }

    #[cfg(unix)]
    #[test]
    fn 系统语言_二进制不存在时是英文且不panic() {
        assert_eq!(system_language_via(Path::new("/nonexistent/rmd-defaults")), Lang::En);
    }

    #[cfg(unix)]
    #[test]
    fn 系统语言_卡住时在预算内放弃并给英文() {
        // ⭐ 这条钉的是**预算存在**：脚本睡 5 s，而调用必须在**传进去的那个预算**量级返回。
        //    ⚠️ 判据写"< 2 s"而不是"≈ 100 ms"——调度抖动不该让这条变红，
        //    而"没有预算"的那种实现会睡满 5 s，两者差一个数量级，2 s 足够区分。
        //    ⚠️ 传 100 ms 而不是生产那个 200 ms：这条要的是**结论**（超时就放弃），
        //    ⛔ 不是复述那个常量——常量由 `SYSTEM_LANGUAGE_BUDGET_MS` 自己表达。
        let p = 假脚本("hang", "#!/bin/sh\nsleep 5\nprintf '(\"zh-Hans-CN\")\\n'\n");
        let t0 = Instant::now();
        let got = system_language_within(&p, Duration::from_millis(100));
        let dt = t0.elapsed();
        assert_eq!(got, Lang::En, "超时必须按英文处理");
        assert!(
            dt < Duration::from_secs(2),
            "⛔ 没有超时预算：等了 {dt:?}（预算 100 ms）"
        );
    }

    #[test]
    fn 线上标签就是字典键() {
        // ⚠️ `services/i18n.js` 的 `DICT` 只有 `zh` / `en` 两本。
        //    这里返回 `zh-CN` 的话前端查不到字典、`t()` 会回落成 key。
        assert_eq!(Lang::Zh.tag(), "zh");
        assert_eq!(Lang::En.tag(), "en");
    }
}
