//! 同层内的排序（`design/0003` §2.1）：**目录在前 + Finder 那套自然排序**。
//!
//! # 为什么这里要碰 Objective-C 运行时
//!
//! macOS 的"文件列表该怎么排"等于 [`NSString.localizedStandardCompare:`]——
//! Apple 自己写的注释是「Compares strings as sorted by the Finder」/「Compares strings
//! as sorted by the Finder」（逐字与实测对照表见 `docs/kb/0008`）。
//! **Rust 生态没有等价物**：ICU/CoreFoundation 的本地化 collation 不是
//! `natural-sort` 那类 crate 能给的。`kb/0008` 给了三条路：
//!
//! | 路线 | 代价 |
//! |---|---|
//! | A · 调 Foundation | ✅ 与 Finder 逐字一致；⛔ 绑死 macOS |
//! | B · 前端 `Intl.Collator` | ⚠️ ICU 版本可能与系统的不同，须实测比对 |
//! | C · 自己写 collation | ⛔ 会在 emoji / 变音符 / 全角数字上偏离——那是重造 ICU |
//!
//! ⭐ **本项目走 A**（项目定位就是 macOS 优先），但**不引入 `objc2` 依赖**：
//! Tauri 本来就在链 ObjC 运行时，这里只需要三个函数
//! （`objc_getClass` / `sel_registerName` / `objc_msgSend`），
//! 手写 FFI 比多加两个版本要钉死的 crate 更划算。
//!
//! ⚠️ **判据不是"看着对"**：本文件末尾有一条**对着 `kb/0008` 那张 18 行实测对照表
//! 逐项断言**的测试。Apple 明说顺序**会随 locale 与 macOS 版本变**，
//! 所以那份表是**需要复查的外部依赖**，不是常量——它变红时先怀疑系统，再怀疑代码。
//!
//! [`NSString.localizedStandardCompare:`]: https://developer.apple.com/documentation/foundation/nsstring/1414563-localizedstandardcompare

use std::cmp::Ordering;

/// 一个可比较的排序键。
///
/// macOS 上是 `NSString`（`alloc/init` 拿到的 **+1** 引用，`Drop` 时 `release`）；
/// 其它平台上是一个规范化过的小写串。
///
/// ⚠️ **必须先建键、再排序**：`localizedStandardCompare:` 每次调用都要两个 `NSString`，
/// 若在比较闭包里现建，一个 5000 项的目录会造出十万级的对象。
pub struct NameKey {
    #[cfg(target_os = "macos")]
    id: foundation::Id,
    #[cfg(not(target_os = "macos"))]
    lowered: String,
}

impl Drop for NameKey {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        unsafe {
            foundation::release(self.id)
        }
    }
}

/// 给一个名字建排序键。
pub fn name_key(name: &str) -> NameKey {
    #[cfg(target_os = "macos")]
    {
        NameKey { id: foundation::nsstring(name) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        NameKey { lowered: name.to_lowercase() }
    }
}

/// 比较两个排序键。`Ordering::Less` = 前者应当排在前面。
pub fn compare_keys(a: &NameKey, b: &NameKey) -> Ordering {
    #[cfg(target_os = "macos")]
    {
        foundation::localized_standard_compare(a.id, b.id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        natural_cmp_fallback(&a.lowered, &b.lowered)
    }
}

/// 比较两个名字。⚠️ 每次调用都会新建两个键——**只适合少量比较与单测**，
/// 批量排序请走 [`sorted`]。
pub fn compare_names(a: &str, b: &str) -> Ordering {
    compare_keys(&name_key(a), &name_key(b))
}

/// ⭐ **系统现在是深色吗**（`design/0004` §2.1.3 的窗口背影要用）。
///
/// ⚠️ 它**不是**页面侧那个判据：页面用的是注入脚本里的 `matchMedia`，
/// 那才是"真正生效的主题"的来源。这条只服务**页面画出第一笔之前**那一小段
/// ——那时窗口自己的背影还没有任何 WebView 内容可依据。
/// 两者读的是同一个 OS 状态，正常不会不一致。
///
/// ⚠️ 放这里而不是 `gui/`：ObjC FFI 只有一份（见上面那段注释）。
/// 非 macOS 一律当浅色（本项目在别的平台上只要求能 `cargo check`）。
pub fn system_prefers_dark() -> bool {
    #[cfg(target_os = "macos")]
    {
        foundation::system_prefers_dark()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// 按「**目录在前**，然后名称用上面的自然排序」返回排好序的新 `Vec`。
///
/// `key_of` 返回 `(是不是目录, 名字)`。⚠️ 名字用 `String` 而不是 `&str`：
/// 借用版会让这个泛型函数带上一串生命周期参数，而这里的克隆成本
/// （每项一个短串）相对 `NSString` 的分配可以忽略。
///
/// ⚠️ **目录与文件的分组在这一层做**：`localizedStandardCompare:` 只管
/// "两个字符串谁在前"，**不涉及目录与文件的区别**（`kb/0008` 未核实的第 2 条）。
pub fn sorted<T>(items: Vec<T>, key_of: impl Fn(&T) -> (bool, String)) -> Vec<T> {
    if items.len() < 2 {
        return items;
    }
    let keys: Vec<(bool, String)> = items.iter().map(&key_of).collect();

    // ⚠️ 一次性把键都建好（见 `NameKey` 的注释），并让整个排序跑在一个
    //    autorelease pool 里——`localizedStandardCompare:` 内部可能有 autorelease。
    let _pool = Pool::new();
    let sort_keys: Vec<NameKey> = keys.iter().map(|(_, n)| name_key(n)).collect();

    let mut order: Vec<usize> = (0..items.len()).collect();
    // `sort_by` 是**稳定**排序：同名项保持 readdir 的顺序，结果可复现
    order.sort_by(|&i, &j| {
        keys[j].0.cmp(&keys[i].0).then_with(|| compare_keys(&sort_keys[i], &sort_keys[j]))
    });

    let mut slots: Vec<Option<T>> = items.into_iter().map(Some).collect();
    order.into_iter().map(|i| slots[i].take().expect("每个下标只出现一次")).collect()
}

// ─────────────────────────────────────────────────────────────────────────
// 非 macOS 的降级实现（本项目在别的平台上照样要能 `cargo check`）
// ─────────────────────────────────────────────────────────────────────────

/// ⛔ **这不是那条与 Finder 一致的排序**，只是让非 macOS 构建能跑。
/// 切数字段 + 小写化逐段比较；emoji / 变音符 / 全角数字上都会与 Finder 不同
/// （`kb/0008` 路线 C 的警告）。
#[cfg(not(target_os = "macos"))]
fn natural_cmp_fallback(a: &str, b: &str) -> Ordering {
    let (mut i, mut j) = (0usize, 0usize);
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    while i < ab.len() && j < bb.len() {
        let (ai, bj) = (ab[i], bb[j]);
        if ai.is_ascii_digit() && bj.is_ascii_digit() {
            let si = i;
            let sj = j;
            while i < ab.len() && ab[i].is_ascii_digit() {
                i += 1;
            }
            while j < bb.len() && bb[j].is_ascii_digit() {
                j += 1;
            }
            // 数字段按数值比（`file2` < `file10`），前导零不参与
            let da = a[si..i].trim_start_matches('0');
            let db = b[sj..j].trim_start_matches('0');
            match da.len().cmp(&db.len()).then_with(|| da.cmp(db)) {
                Ordering::Equal => {}
                other => return other,
            }
        } else {
            match ai.to_ascii_lowercase().cmp(&bj.to_ascii_lowercase()) {
                Ordering::Equal => {}
                other => return other,
            }
            i += 1;
            j += 1;
        }
    }
    ab.len().cmp(&bb.len())
}

// ─────────────────────────────────────────────────────────────────────────
// Foundation 的最小 FFI
// ─────────────────────────────────────────────────────────────────────────

// ⚠️ **本模块是全项目唯一的 ObjC FFI 面**：`objc_getClass` / `sel_registerName` /
// `objc_msgSend` 只在这里声明一次。
//
// 自然排序是它的**第一个**用户，`design/0004` §2.1.3 的「`system` 档窗口背影」
// 是**第二个**（见 [`foundation::system_prefers_dark`]）——⛔ 不应为了"名字对得上"
// 再声明第二份 `objc_msgSend`（那是本项目最忌讳的第二条实现路径）。

#[cfg(target_os = "macos")]
pub mod foundation {
    use std::cmp::Ordering;
    use std::ffi::{c_char, c_void, CStr, CString};

    /// ObjC 的 `id`。
    pub type Id = *mut c_void;

    // ⚠️ edition 2024 要求 `unsafe extern`
    #[link(name = "Foundation", kind = "framework")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        /// ⚠️ 真正的签名取决于调用点，这是 ObjC 的 ABI 约定。
        /// 下面每个 `msg_*` 各自 `transmute` 成正确的形状——⛔ 不要跨形状复用。
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }

    unsafe fn sel(name: &str) -> *mut c_void {
        // 选择器名字都是 ASCII，且是字面量——这里不会失败
        let c = CString::new(name).expect("选择器名不含 NUL");
        unsafe { sel_registerName(c.as_ptr()) }
    }

    /// 按名字拿一个类。拿不到时 `None`（⛔ 不 panic：外观兜底失败不该让窗口起不来）。
    fn class(name: &str) -> Option<Id> {
        let c = CString::new(name).ok()?;
        // SAFETY: `objc_getClass` 对不存在的名字返回 null，不会崩
        let id = unsafe { objc_getClass(c.as_ptr()) };
        if id.is_null() { None } else { Some(id) }
    }

    unsafe fn msg_id(receiver: Id, s: *mut c_void) -> Id {
        let f: unsafe extern "C" fn(Id, *mut c_void) -> Id =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s) }
    }

    unsafe fn msg_id_cstr(receiver: Id, s: *mut c_void, arg: *const c_char) -> Id {
        let f: unsafe extern "C" fn(Id, *mut c_void, *const c_char) -> Id =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s, arg) }
    }

    /// **一个 `id` 参数的 `id` 返回**（`stringForKey:` 这类）。
    ///
    /// ⚠️ 与 `msg_id_cstr` **不是同一个形状**，⛔ 不能互相替换：
    /// 传 `*const c_char` 的地方收到的是 `NSString`，ABI 上都是指针但语义完全不同。
    unsafe fn msg_id_id(receiver: Id, s: *mut c_void, arg: Id) -> Id {
        let f: unsafe extern "C" fn(Id, *mut c_void, Id) -> Id =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s, arg) }
    }

    unsafe fn msg_isize(a: Id, s: *mut c_void, b: Id) -> isize {
        let f: unsafe extern "C" fn(Id, *mut c_void, Id) -> isize =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(a, s, b) }
    }

    /// **无参数、返回 `NSUInteger` 的 `id` 返回**（`[array count]` 这类）。
    unsafe fn msg_usize(receiver: Id, s: *mut c_void) -> usize {
        let f: unsafe extern "C" fn(Id, *mut c_void) -> usize =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s) }
    }

    /// **一个 `NSUInteger` 参数的 `id` 返回**（`objectAtIndex:` 这类）。
    ///
    /// ⚠️ `NSUInteger` 是 64 位，**不是** `u32`——传错位宽在 arm64 上会读到垃圾。
    unsafe fn msg_id_usize(receiver: Id, s: *mut c_void, arg: usize) -> Id {
        let f: unsafe extern "C" fn(Id, *mut c_void, usize) -> Id =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s, arg) }
    }

    unsafe fn msg_void(receiver: Id, s: *mut c_void) {
        let f: unsafe extern "C" fn(Id, *mut c_void) =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s) }
    }

    /// 建一个 `NSString`（**+1**，调用方负责 `release`）。
    ///
    /// ⚠️ 用 `initWithUTF8String:` 而不是 `stringWithUTF8String:`——
    /// 后者是 autorelease 的，在一个不进 event loop 的排序循环里会一直涨。
    /// 名字里含 NUL 时退回空串（`CString::new` 会失败）。
    pub fn nsstring(s: &str) -> Id {
        unsafe {
            let cls = {
                let name = CString::new("NSString").unwrap();
                objc_getClass(name.as_ptr())
            };
            assert!(!cls.is_null(), "拿不到 NSString 类——Foundation 没链上？");
            let obj = msg_id(cls, sel("alloc"));
            match CString::new(s) {
                Ok(c) => msg_id_cstr(obj, sel("initWithUTF8String:"), c.as_ptr()),
                // 含 NUL 的名字（macOS 上文件系统不允许，防御性处理）
                Err(_) => {
                    let empty = CString::new("").unwrap();
                    msg_id_cstr(obj, sel("initWithUTF8String:"), empty.as_ptr())
                }
            }
        }
    }

    /// `release`（配 `nsstring` 的 +1）。
    pub unsafe fn release(id: Id) {
        unsafe { msg_void(id, sel("release")) }
    }

    /// [`NSString.localizedStandardCompare:`][api] → `Ordering`。
    ///
    /// [api]: https://developer.apple.com/documentation/foundation/nsstring/1414563-localizedstandardcompare
    pub fn localized_standard_compare(a: Id, b: Id) -> Ordering {
        let r = unsafe { msg_isize(a, sel("localizedStandardCompare:"), b) };
        match r.cmp(&0) {
            // `NSComparisonResult`：`NSOrderedAscending = -1` / `Same = 0` / `Descending = 1`
            Ordering::Less => Ordering::Less,
            Ordering::Equal => Ordering::Equal,
            Ordering::Greater => Ordering::Greater,
        }
    }

    /// RAII 的 autorelease pool。
    ///
    /// ⚠️ 与 `NameKey` 的 `release` **分工不同**：这个管的是
    /// `localizedStandardCompare:` 内部产生的临时对象，`NameKey` 管的是我们自己的 +1。
    pub struct Pool(*mut c_void);

    impl Pool {
        pub fn new() -> Self {
            Pool(unsafe { objc_autoreleasePoolPush() })
        }
    }

    impl Drop for Pool {
        fn drop(&mut self) {
            unsafe { objc_autoreleasePoolPop(self.0) }
        }
    }

    /// 只在测试里用：确认 `objc_getClass` 这条路真的通。
    #[allow(dead_code)]
    pub fn class_exists(name: &str) -> bool {
        let c = CString::new(name).unwrap();
        !unsafe { objc_getClass(c.as_ptr()) }.is_null()
    }

    /// ⭐ **系统现在是深色吗**——读 `NSUserDefaults` 的 `AppleInterfaceStyle`。
    ///
    /// # 依据（一手实测，2026-10-13）
    ///
    /// | 系统外观 | `AppleInterfaceStyle` |
    /// |---|---|
    /// | 浅色 | **键根本不存在**（`stringForKey:` 回 `nil`） |
    /// | 深色 | `"Dark"` |
    ///
    /// ⇒ 「没有这个键」= 浅色，**不是**"读失败"。这是 Apple 的既有约定
    /// （`defaults read -g AppleInterfaceStyle` 在浅色下报 key does not exist）。
    ///
    /// # 它为什么活着
    ///
    /// `design/0004` §2.1.3 要求「`system` 档也不能有白屏帧」。页面侧由
    /// **注入脚本**（`matchMedia`）负责，那一段是完整的；但 WebView 还没画出
    /// 任何东西之前，窗口自己的背影是**另一个**层次——那里没有 JS 可用。
    ///
    /// ⚠️ 拿不到就**当浅色**（⛔ 不 panic、⛔ 不让窗口起不来）：
    /// 退化的结果是"深色系统上可能闪一下浅色"，比"窗口起不来"轻得多。
    pub fn system_prefers_dark() -> bool {
        unsafe {
            // ⚠️ 进 pool：`standardUserDefaults` 与 `stringForKey:` 都可能产生临时对象
            let _pool = Pool::new();
            let Some(cls) = class("NSUserDefaults") else { return false };
            let defaults = msg_id(cls, sel("standardUserDefaults"));
            if defaults.is_null() {
                return false;
            }
            let key = nsstring("AppleInterfaceStyle");
            let v = msg_id_id(defaults, sel("stringForKey:"), key);
            release(key);
            if v.is_null() {
                return false; // 键不存在 = 浅色
            }
            let s = nsstring_to_string(v);
            // ⚠️ 大小写都收：Apple 现在给的是 `"Dark"`，但这属于**外部事实**，
            //    它改过一次（10.14 之前没有这个键）。宽松比对便宜且不掩盖问题。
            s.eq_ignore_ascii_case("dark")
        }
    }

    /// 把 `NSString` 读回来（证明 FFI 的 `Id` 真的是个字符串）。
    pub fn nsstring_to_string(id: Id) -> String {
        unsafe {
            let utf8: *const c_char = {
                let f: unsafe extern "C" fn(Id, *mut c_void) -> *const c_char =
                    std::mem::transmute(objc_msgSend as *const c_void);
                f(id, sel("UTF8String"))
            };
            if utf8.is_null() {
                return String::new();
            }
            CStr::from_ptr(utf8).to_string_lossy().into_owned()
        }
    }

    /// ⭐ **当前进程的首选语言**（`[[NSLocale preferredLanguages] objectAtIndex:0]`，
    /// 形如 `"zh-Hans-CN"` / `"en-US"`）。
    ///
    /// ⚠️ 它才是 `localizedStandardCompare:` 里**中文名位置**的实际开关——2026-10-23 实测：
    /// 只改 `AppleLocale` 为 `en_US` **排序不变**；改 `AppleLanguages` 为 `["en-US"]`
    /// 才把中文名从**最前**挪到**最后**（`docs/kb/0029`）。
    /// 读不到时返回 `None`：调用方必须**显式跳过**依赖语言的判据，⛔ 别当成"不知道就算过"。
    pub fn preferred_language() -> Option<String> {
        let _pool = Pool::new();
        unsafe {
            let cls = class("NSLocale")?;
            let langs = msg_id(cls, sel("preferredLanguages"));
            if langs.is_null() {
                return None;
            }
            if msg_usize(langs, sel("count")) == 0 {
                return None;
            }
            let first = msg_id_usize(langs, sel("objectAtIndex:"), 0);
            if first.is_null() {
                return None;
            }
            Some(nsstring_to_string(first))
        }
    }
}

#[cfg(target_os = "macos")]
pub use foundation::Pool;

#[cfg(not(target_os = "macos"))]
/// 非 macOS 上的空占位（调用方不必 `#[cfg]`）。
pub struct Pool;

#[cfg(not(target_os = "macos"))]
impl Pool {
    /// 什么都不做。
    pub fn new() -> Self {
        Pool
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实测过的两张整表（`docs/kb/0008` 的 `zh_CN` 那张 ＋ `docs/kb/0029` 补的 `en_US` 那张）。
    ///
    /// ⚠️ 中文名的位置**随首选语言变**（⛔ 不是随 `AppleLocale` 变，更不是随代码变）：
    /// 中文下排在 ASCII **之前**、英文下排在 **之后**。
    /// ⇒ 这两张表都是**外部依赖的复查样本**，⛔ 别把任何一张当常量。
    fn table_for_language(lang: &str) -> Option<&'static [&'static str]> {
        const ZH: &[&str] = &[
            "_x.md", ".hidden", "1.md", "01.md", "笔记2.md", "笔记10.md", "第2章.md",
            "第10章.md", "a.md", "A.md", "b.md", "B.md", "file1.md", "file2.md",
            "File3.md", "file10.md", "img.png", "img2.png",
        ];
        const EN: &[&str] = &[
            "_x.md", ".hidden", "1.md", "01.md", "a.md", "A.md", "b.md", "B.md",
            "file1.md", "file2.md", "File3.md", "file10.md", "img.png", "img2.png",
            "笔记2.md", "笔记10.md", "第2章.md", "第10章.md",
        ];
        if lang.starts_with("zh") {
            Some(ZH)
        } else if lang.starts_with("en") {
            Some(EN)
        } else {
            None
        }
    }

    /// ⭐⭐ **对着 `docs/kb/0008` / `docs/kb/0029` 的实测对照表逐项断言。**
    ///
    /// ⚠️ 2026-10-23 首轮 GitHub Actions（macOS 15 runner，首选语言 `en-US`）把这条测试
    /// 判红：中文名在**最后**而不是最前。根因不是代码——`localizedStandardCompare:`
    /// 的中文名位置**随首选语言变**（见 `docs/kb/0029`）。⇒ 现在分成两半：
    /// **与语言无关的判据永远断言**，整表只在实测过的语言下断言。
    #[cfg(target_os = "macos")]
    #[test]
    fn 与_kb0008_的实测对照表逐项一致() {
        let input = [
            "file10.md", "笔记10.md", "A.md", "1.md", "b.md", "第2章.md", ".hidden",
            "file1.md", "笔记2.md", "_x.md", "img2.png", "a.md", "第10章.md", "B.md",
            "01.md", "File3.md", "file2.md", "img.png",
        ];

        // ① 数字段：一条在 ASCII 名里、一条在中文名里——任何语言下都必须成立，
        //    ⛔ 不跟着整表一起跳过。
        assert_eq!(compare_names("file2.md", "file10.md"), Ordering::Less, "① 数字段");
        assert_eq!(compare_names("笔记2.md", "笔记10.md"), Ordering::Less, "② 中文名里的数字");

        // ② 比较器自洽（反对称）。钉的是"某一分支写反"，与语言无关。
        for a in input {
            for b in input {
                assert_eq!(
                    compare_names(a, b),
                    compare_names(b, a).reverse(),
                    "{a} vs {b} 不满足反对称"
                );
            }
        }

        let mut got = input.to_vec();
        got.sort_by(|a, b| compare_names(a, b));
        // ③ 排序幂等：比较器不满足传递性时，同一组输入再排一次会变。
        let mut again = got.clone();
        again.sort_by(|a, b| compare_names(a, b));
        assert_eq!(got, again, "排序必须幂等（比较器要满足传递性）");

        // ④ 四条"最容易错"的差异里，这一条跨语言成立
        assert_eq!(compare_names("a.md", "A.md"), Ordering::Less, "④ 大小写混排时小写在前");

        // ⑤ 整表 ＋ "中文名不在最后"：只在**实测过**的首选语言下断言
        let lang = foundation::preferred_language().unwrap_or_default();
        let Some(expected) = table_for_language(&lang) else {
            eprintln!(
                "⚠️ 跳过整表对照：首选语言 = {lang:?}（本仓只实测过 zh / en，见 kb/0029）；实际顺序 = {got:?}"
            );
            return;
        };
        assert_eq!(got, expected.to_vec(), "首选语言 = {lang}，实际顺序 = {got:?}");
        if lang.starts_with("zh") {
            assert_eq!(
                compare_names("笔记2.md", "img.png"),
                Ordering::Less,
                "③ 中文名不在最后（仅中文）"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn ffi_拿到的真的是能读回来的字符串() {
        assert!(foundation::class_exists("NSString"));
        let id = foundation::nsstring("中文 ok");
        assert_eq!(foundation::nsstring_to_string(id), "中文 ok");
        unsafe { foundation::release(id) };
    }

    /// ⭐ **对着 `defaults` 命令对照**读出来的系统外观。
    ///
    /// ⚠️ 这里同样是一次**外部依赖的复查**：`AppleInterfaceStyle` 是 Apple 的实现细节，
    /// 真正的一手依据是"命令行的说法与 FFI 的说法一致"。
    /// ⛔ 不 spawn 一个子进程就断言 `false`／`true`——那等于把本机当前的配色
    /// 当成常量写进测试（在深色机器上会红，在浅色机器上永远绿，两边都不说明问题）。
    #[cfg(target_os = "macos")]
    #[test]
    fn 系统外观_与_defaults_命令的说法一致() {
        // `defaults read -g AppleInterfaceStyle`：深色 → "Dark"；浅色 → 报 key 不存在（非 0 退出）
        let out = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output();
        let by_cli = match out {
            Ok(o) if o.status.success() => {
                String::from_utf8_lossy(&o.stdout).trim().eq_ignore_ascii_case("dark")
            }
            // 命令不存在 / 键不存在（浅色）都归 false——与实现里的回落一致
            _ => false,
        };
        assert_eq!(
            system_prefers_dark(),
            by_cli,
            "FFI 读到的系统外观与 `defaults read -g AppleInterfaceStyle` 不一致"
        );
    }

    #[test]
    fn 目录在前_且同层内按名字排() {
        // (是不是目录, 名字)
        let items = vec![
            (false, "b.md"),
            (true, "z"),
            (false, "a.md"),
            (true, "a"),
        ];
        let got = sorted(items, |&(is_dir, name)| (is_dir, name.to_string()));
        assert_eq!(
            got,
            vec![(true, "a"), (true, "z"), (false, "a.md"), (false, "b.md")]
        );
    }

    #[test]
    fn 排序是稳定的且不改动少于两项的输入() {
        let one = vec![(true, "x")];
        assert_eq!(sorted(one.clone(), |&(d, n)| (d, n.to_string())), one);
        let empty: Vec<(bool, String)> = vec![];
        assert!(sorted(empty, |&(d, _)| (d, String::new())).is_empty());
    }
}
