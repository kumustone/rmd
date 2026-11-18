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
///
/// ⚠️ **只给单测**：产品侧批量排序走 `sorted`（预建键），没有逐对比的调用方。
#[cfg(test)]
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
        /// 运行时造类（`design/0080`：打印完成回调的委托，见 `print_delegate_class`）。
        ///
        /// ⚠️ 这三个都在 libobjc 里，随 Foundation 一起链上；⛔ 不必新增任何 `#[link]`。
        fn objc_allocateClassPair(
            superclass: Id,
            name: *const c_char,
            extra_bytes: usize,
        ) -> Id;
        fn objc_registerClassPair(cls: Id);
        fn class_addMethod(
            cls: Id,
            name: *mut c_void,
            imp: *mut c_void,
            types: *const c_char,
        ) -> i8;
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
    ///
    /// ⚠️ **只给单测**的 `preferred_language` 用；产品侧不读 `NSLocale`。
    #[cfg(test)]
    unsafe fn msg_usize(receiver: Id, s: *mut c_void) -> usize {
        let f: unsafe extern "C" fn(Id, *mut c_void) -> usize =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s) }
    }

    /// **一个 `NSUInteger` 参数的 `id` 返回**（`objectAtIndex:` 这类）。
    ///
    /// ⚠️ `NSUInteger` 是 64 位，**不是** `u32`——传错位宽在 arm64 上会读到垃圾。
    ///
    /// ⚠️ 与 [`msg_usize`] 同族：**只给单测**的 `preferred_language` 用。
    #[cfg(test)]
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
    /// ⚠️ **只给单测**：产品侧不读进程语言（`localizedStandardCompare:` 自己会看）。
    /// 测试用它决定"要不要跑依赖语言的判据"——读不到就**显式跳过**（`docs/kb/0029`）。
    #[cfg(test)]
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

    // ─────────────────────────────────────────────────────────────────────
    // ⭐ 打印作业**直接写 PDF 文件**（`design/0080`）
    // ─────────────────────────────────────────────────────────────────────
    //
    // 它仍然是**这里**：全项目唯一的 ObjC FFI 面（见本模块开头）。⛔ 不为打印新开第二个
    // FFI 文件、⛔ 不把 `objc2` 变成直接依赖、⛔ 不手抄 `NSPrintJobDisposition` 的字面值
    // （那是 AppKit 导出的 `NSString *` **变量**，只有 `dlsym` 能按名字拿到）。
    //
    // ⚠️ 整段 `#[cfg(feature = "gui")]`：CLI（`rmd probe` / `rmd bench`）没有 WKWebView，
    //    也不该为了它多链任何东西。

    /// `RTLD_DEFAULT`（`dlfcn.h`：`((void *) -2)`，搜全部已载入的镜像）。
    ///
    /// ⚠️ 只在一次导出里用三次，`dlfcn.h` 那条「very expensive」的告诫可以忽略；
    /// ⛔ 别把它塞进热路径。
    #[cfg(feature = "gui")]
    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

    // ⚠️ 只借 `libSystem`（本来就在链上），⛔ 不挂 `#[link(name = "AppKit")]`：
    // 我们要的是 AppKit **导出的两个常量**，不是它的类；走 `dlsym` 就不必让
    // 非 GUI 构建（乃至 GUI 构建的链接行）多一条框架依赖。
    #[cfg(feature = "gui")]
    unsafe extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    /// **一个 `CGFloat` 参数的 void 返回**（`setTopMargin:` 一族）。
    #[cfg(feature = "gui")]
    unsafe fn msg_void_f64(receiver: Id, s: *mut c_void, arg: f64) {
        let f: unsafe extern "C" fn(Id, *mut c_void, f64) =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s, arg) }
    }

    /// **两个 `id` 参数、void 返回**（`setObject:forKey:`）。
    ///
    /// ⚠️ 参数顺序是**值在前、键在后**——写反了不报错，只会往字典里塞进一个没人读的键。
    #[cfg(feature = "gui")]
    unsafe fn msg_void_id_id(receiver: Id, s: *mut c_void, a: Id, b: Id) {
        let f: unsafe extern "C" fn(Id, *mut c_void, Id, Id) =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s, a, b) }
    }

    /// **一个 `id` ＋ 一个 `NSInteger`、void 返回**（`addTabbedWindow:ordered:`）。
    ///
    /// ⚠️ `NSWindowOrderingMode` 是 `NSInteger`（`NSWindowAbove = 1` / `NSWindowBelow = -1`），
    /// ⛔ 不是 `BOOL`、⛔ 不是 `NSUInteger`——传错形状在这里不会报错，只会把窗口并错层。
    #[cfg(feature = "gui")]
    unsafe fn msg_void_id_isize(receiver: Id, s: *mut c_void, arg: Id, mode: isize) {
        let f: unsafe extern "C" fn(Id, *mut c_void, Id, isize) =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s, arg, mode) }
    }

    /// `NSWindowOrderingMode` 的取值（`NSWindow.h`）。
    ///
    /// ⚠️⚠️ **三个值全都有名字**：`NSWindowAbove = 1`、`NSWindowBelow = -1`、
    /// `NSWindowOut = 0`——最后那个是"把窗口移出屏幕"。
    /// ⇒ ⛔ **绝不能用 `0` 表示"below"**：那样一眼看不出错，行为却是把标签从屏幕里摘出去。
    /// 传错形状/取值**不会报错**，只会把窗口并错层或干脆看不见。
    #[cfg(feature = "gui")]
    pub const fn ordering_mode(above: bool) -> isize {
        if above {
            1
        } else {
            -1
        }
    }

    /// ⭐ **把一个窗口并进另一个窗口的原生标签组**（`design/0083` §2.2）。
    ///
    /// `target` / `tab` 都是 `NSWindow` 指针（Tauri 的 `WebviewWindow::ns_window()`）。
    /// `above = true` ⇒ `NSWindowAbove`（1）：新标签紧跟在当前标签之后。
    ///
    /// ⚠️ **必须在主线程调用**（AppKit 的窗口层级不是线程安全的）。现调用点
    /// （`gui/mod.rs::open_new_tab`）在菜单事件里，本来就在事件循环线程上。
    /// ⚠️ 调完之后**不要假设新标签已选中**：`addTabbedWindow:ordered:` 只保证"并进去了"，
    /// 选中由调用方的 `set_focus()` 完成。
    /// ⚠️ 它对**已经在同一标签组里**的窗口是 no-op（AppKit 的行为），⛔ 我们不再自己判一次。
    ///
    /// 返回 `false` = 入参是空指针（⛔ 不 panic：这一步失败之后调用方要关掉那个窗口，
    /// 在关的路上崩掉比"没并成"更糟）。
    #[cfg(feature = "gui")]
    pub fn add_tabbed_window(target: Id, tab: Id, above: bool) -> bool {
        if target.is_null() || tab.is_null() {
            return false;
        }
        // SAFETY: 两个指针都由调用方从**活着**的 NSWindow 取到，且本函数只在主线程调。
        unsafe {
            msg_void_id_isize(
                target,
                sel("addTabbedWindow:ordered:"),
                tab,
                ordering_mode(above),
            );
        }
        true
    }

    /// **一个 `BOOL` 参数、void 返回**（`setShowsPrintPanel:`）。
    ///
    /// ⚠️ `BOOL` 只有 1 字节（arm64 是 C 的 `bool`，x86_64 是 `signed char`）⇒ 一律按 `i8` 传，
    /// 传 0 / 1 在两种 ABI 下都是同一个字节。⛔ 别在这里用 Rust 的 `bool` 省一个字符——
    /// 那会把「ObjC 的 BOOL 是什么」写成一个**没人复核的假设**。
    #[cfg(feature = "gui")]
    unsafe fn msg_void_bool(receiver: Id, s: *mut c_void, arg: i8) {
        let f: unsafe extern "C" fn(Id, *mut c_void, i8) =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s, arg) }
    }

    /// **一个 `SEL` 参数、返回 `BOOL`**（`respondsToSelector:`）。
    #[cfg(feature = "gui")]
    unsafe fn msg_bool_sel(receiver: Id, s: *mut c_void, arg: *mut c_void) -> i8 {
        let f: unsafe extern "C" fn(Id, *mut c_void, *mut c_void) -> i8 =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s, arg) }
    }

    /// **一个 `(const char *, NSUInteger)` 参数的类方法**（`+stringWithFileSystemRepresentation:length:`）。
    ///
    /// ⚠️ `length` 是 `NSUInteger`（64 位），⛔ 不是 `u32`。
    #[cfg(feature = "gui")]
    unsafe fn msg_id_cstr_usize(receiver: Id, s: *mut c_void, p: *const c_char, n: usize) -> Id {
        let f: unsafe extern "C" fn(Id, *mut c_void, *const c_char, usize) -> Id =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(receiver, s, p, n) }
    }

    /// 从 `dlsym` 取一个 AppKit 导出的 `NSString *` 常量（取不到 ⇒ `None`）。
    ///
    /// ⚠️ 符号本身是**变量**（`APPKIT_EXTERN NSString * const NSPrintSaveJob`），
    /// `dlsym` 给的是它**地址** ⇒ 必须**再解引用一次**才是那个 `NSString`。
    /// 只解一层就当成 `Id` 用的话，拿到的是 `NSString **`，`objc_msgSend` 会把一个栈地址
    /// 当对象发消息——那是崩溃，而且崩在 AppKit 里、看不出是我们传错了。
    #[cfg(feature = "gui")]
    unsafe fn dlsym_string(name: &str) -> Option<Id> {
        let c = CString::new(name).ok()?;
        let p = unsafe { dlsym(RTLD_DEFAULT, c.as_ptr()) };
        if p.is_null() {
            return None;
        }
        let v = unsafe { *(p as *const Id) };
        if v.is_null() { None } else { Some(v) }
    }

    /// `+[NSString stringWithFileSystemRepresentation:length:]`（**+0**，autoreleased）。
    ///
    /// ⚠️ 路径必须走**文件系统表示**（字节）而不是 UTF-8：macOS 上文件名允许非 UTF-8
    /// 字节，`to_string_lossy()` 会把它们换成 U+FFFD ⇒ 那是**另一个路径**
    /// （与 `INV-EXT-01` 同一条理由）。⚠️ 只在调用方的 autorelease pool 里有效。
    #[cfg(feature = "gui")]
    unsafe fn nsstring_fs(path: &std::path::Path) -> Option<Id> {
        use std::os::unix::ffi::OsStrExt;
        let bytes = path.as_os_str().as_bytes();
        let cls = class("NSString")?;
        // SAFETY: `bytes` 在本次调用期间有效，长度按字节算
        let s = unsafe {
            msg_id_cstr_usize(
                cls,
                sel("stringWithFileSystemRepresentation:length:"),
                bytes.as_ptr() as *const c_char,
                bytes.len(),
            )
        };
        if s.is_null() { None } else { Some(s) }
    }

    /// ⭐ **让 `WKWebView` 把当前页面静默打成 PDF 文件**（`design/0080` §2.1）。
    ///
    /// # 它做的事（顺序不能换）
    ///
    /// 1. `respondsToSelector:` 探一下 `printOperationWithPrintInfo:`——拿不到就**别往下走**
    ///    （老 WebKit / 传进来的不是 WKWebView 时，再发消息就是 unrecognized selector）。
    /// 2. `[[NSPrintInfo alloc] init]`：**自建**一份，⛔ 不碰 `sharedPrintInfo`
    ///    （`INV-PDF-05`：那是进程共享对象，改了它之后**任何**一次普通打印都会带着
    ///    "保存为文件"的 disposition）。
    /// 3. 四个边距写 0——与 wry 的 `print_with_options` 同口径：页边距只由 `print.css`
    ///    的 `@page` 给。⚠️ 这里写 0 不是"没边距"，是"别叠两层"。
    /// 4. `NSPrintJobDisposition = NSPrintSaveJob` ＋ `NSPrintJobSavingURL = file://<path>`。
    /// 5. `printOperationWithPrintInfo:` → 关掉打印面板与进度面板
    ///    → `runOperationModalForWindow:delegate:didRunSelector:contextInfo:`。
    ///
    /// # ⚠️ 为什么是「document-modal」而不是 `runOperation`（`bugs/0324`）
    ///
    /// `-[NSPrintOperation runOperation]` 是**应用级模态**，没有窗口上下文 ⇒ WebKit 的打印
    /// 视图停在 **0×0**、`knowsPageRange:` 报 `length = NSIntegerMax`（"页数未知"），
    /// 作业随后**一页一页无限往下写**：2026-11-15 真机导出一份 ARCHITECTURE.md，
    /// 半分钟内写出 **705 MB / 270 万页**且仍在涨，主线程卡死。
    /// `runOperationModalForWindow:` 把作业挂到窗口的打印会话上，同一份 HTML 实测
    /// **12 页 / 31 KB / 一两秒结束**（`bugs/0324` §3 的离屏探针）。
    /// ⛔ 别为了"同步好写"改回 `runOperation`。
    ///
    /// # 返回值
    ///
    /// `true` = 作业**已派发**，结果稍后由委托回调经 `done` 送回（可能成功也可能失败）。
    /// `false` = 连派发都没做到（拿不到 webview/窗口/作业）⇒ 调用方自己判失败。
    /// ⚠️ 派发成功**不等于**文件写出来了：调用方仍必须再判一次读回的字节数
    /// （`design/0080` §6 第三件事）。
    #[cfg(feature = "gui")]
    pub fn print_webview_to_pdf(
        wk: Id,
        path: &std::path::Path,
        done: std::sync::mpsc::Sender<bool>,
    ) -> bool {
        if wk.is_null() {
            return false;
        }
        // 作业期间会产生一堆临时对象（字典、NSURL、委托）⇒ 进自己的 pool，
        // ⚠️ 与调用方（事件循环）的那个 pool 不冲突：嵌套是合法的。
        let _pool = Pool::new();
        unsafe {
            // ① 能力探测
            if msg_bool_sel(wk, sel("respondsToSelector:"), sel("printOperationWithPrintInfo:")) == 0 {
                return false;
            }
            // ⭐ document-modal 需要一个窗口：拿不到就别派发（`bugs/0324`）
            let window = msg_id(wk, sel("window"));
            if window.is_null() {
                return false;
            }
            let Some(delegate_cls) = print_delegate_class() else { return false };
            let Some(url_key) = dlsym_string("NSPrintJobSavingURL") else { return false };
            let Some(disp_key) = dlsym_string("NSPrintJobDisposition") else { return false };
            let Some(save_job) = dlsym_string("NSPrintSaveJob") else { return false };
            let Some(url) = nsstring_fs(path).and_then(|p| {
                let cls = class("NSURL")?;
                let u = msg_id_id(cls, sel("fileURLWithPath:"), p);
                if u.is_null() { None } else { Some(u) }
            }) else {
                return false;
            };

            // ② 自建 NSPrintInfo（`init` = `initWithDictionary:nil`，取默认打印机的默认纸张）
            let Some(info_cls) = class("NSPrintInfo") else { return false };
            let info = msg_id(info_cls, sel("alloc"));
            if info.is_null() {
                return false;
            }
            let info = msg_id(info, sel("init"));
            if info.is_null() {
                return false;
            }

            // ⚠️ `op` / `info` 都是 `+0`（或本函数里 `alloc/init` 出来的 `+1`），
            //    而作业是**异步**跑的、下面的 autorelease pool 一返回就 pop ——
            //    显式 `retain`，交给回调统一 `release`。
            //
            //    ⭐ 实测（2026-11-15，离屏探针 `probe_own` 的变异对照）：**不 retain**
            //    也能跑完并写出同样的 31 754 B —— 说明 AppKit 在会话期间自己持有作业与
            //    打印信息。⇒ 这一对 `retain`/`release` **不是**必需的，保留它是为了让
            //    "异步期间这两个对象必须活着"写成显式契约，⛔ 不是靠一条未文档化的行为。
            //    也正因为 AppKit 自己持有一份，回调里 `release` 我们这一份**不会**
            //    把正在收尾的作业提前释放掉。
            let mut keep: Vec<Id> = Vec::new();
            let dispatched = (|| -> bool {
                for m in [
                    "setTopMargin:",
                    "setBottomMargin:",
                    "setLeftMargin:",
                    "setRightMargin:",
                ] {
                    msg_void_f64(info, sel(m), 0.0);
                }
                let dict = msg_id(info, sel("dictionary"));
                if dict.is_null() {
                    return false;
                }
                // ⚠️ 参数顺序是「值, 键」（`setObject:forKey:`）
                msg_void_id_id(dict, sel("setObject:forKey:"), save_job, disp_key);
                msg_void_id_id(dict, sel("setObject:forKey:"), url, url_key);

                let op = msg_id_id(wk, sel("printOperationWithPrintInfo:"), info);
                if op.is_null() {
                    return false;
                }
                msg_void(op, sel("retain"));
                keep.push(op);
                // ⛔ 两个面板都关：用户要的是"一步得到 .pdf"，不是又一个系统面板
                msg_void_bool(op, sel("setShowsPrintPanel:"), 0);
                msg_void_bool(op, sel("setShowsProgressPanel:"), 0);

                // ③ 委托：`alloc/init` 是 +1，由回调里的 `release` 配平
                let delegate = msg_id(msg_id(delegate_cls, sel("alloc")), sel("init"));
                if delegate.is_null() {
                    return false;
                }
                msg_void(info, sel("retain"));
                keep.push(info);
                // ④ 载荷所有权交给回调（`Box::into_raw` ⇒ 回调 `Box::from_raw`）
                let ctx = Box::into_raw(Box::new(PrintDone {
                    tx: done,
                    keep: std::mem::take(&mut keep),
                }));
                msg_void_modal(
                    op,
                    sel("runOperationModalForWindow:delegate:didRunSelector:contextInfo:"),
                    window,
                    delegate,
                    sel("printOperationDidRun:success:contextInfo:"),
                    ctx as *mut c_void,
                );
                true
            })();
            // `info` 的 `alloc/init` 那一份；回调里释放的是上面 `retain` 的那一份
            release(info);
            // 派发失败 ⇒ 上面 `retain` 的那几份没人会去释放，就地配平
            for id in keep {
                release(id);
            }
            dispatched
        }
    }

    /// 打印完成回调的载荷：把结果送回在 `recv_timeout` 上等的那条线程，
    /// 并释放必须活到回调那一刻的对象（`op` / `info`）。
    #[cfg(feature = "gui")]
    struct PrintDone {
        tx: std::sync::mpsc::Sender<bool>,
        /// 派发时 `retain` 过、⛔ 只由回调 `release` 的对象。
        keep: Vec<Id>,
    }

    /// `-printOperationDidRun:success:contextInfo:` 的实现（**C 函数**，不是 block）。
    ///
    /// ⚠️ `ctx` 是调用方 `Box::into_raw` 交出来的**所有权** ⇒ 这里必须取回并释放，
    /// 否则每次导出漏一个 `Sender`。
    /// ⚠️ 作业**永不回调**（调用方 180 s 超时）时那个 Box **故意不回收**：回收它会让
    /// 晚到的回调写进已释放内存（UAF）；漏一个几十字节的 Box 远比崩溃可接受。
    /// ⚠️ `me` 是派发时 `alloc/init` 出来的那份 +1，这里释放它；传 null 时跳过（单测用）。
    #[cfg(feature = "gui")]
    unsafe extern "C" fn print_did_run(
        me: Id,
        _cmd: *mut c_void,
        _op: Id,
        success: i8,
        ctx: *mut c_void,
    ) {
        unsafe {
            if !ctx.is_null() {
                let done = Box::from_raw(ctx as *mut PrintDone);
                // ⚠️ 接收方可能已经超时走人（通道断开）——那不是错误，⛔ 别 panic
                let _ = done.tx.send(success != 0);
                // 派发时 `retain` 的那几份（`op` / `info`）：作业已经结束，配平掉
                for id in done.keep {
                    release(id);
                }
            }
            if !me.is_null() {
                msg_void(me, sel("release"));
            }
        }
    }

    /// 委托类名。⚠️ 进程内只能注册一次（重名时 `objc_allocateClassPair` 返回 null）。
    #[cfg(feature = "gui")]
    const PRINT_DELEGATE_CLASS: &str = "RmdPrintDone";

    /// 按需注册打印完成的委托类，返回类对象。
    ///
    /// ⚠️ 用**运行时造类 ＋ C 函数 IMP ＋ `contextInfo`**，⛔ 不用 block：
    /// 那要把 block 字面量按 ABI 手工摆（`_NSConcreteStackBlock`、flags、descriptor），
    /// 摆错了只在回调那一刻崩；而 `contextInfo` 本来就是给回调捎一个指针用的。
    /// ⚠️ `BOOL` 的类型编码按架构不同（arm64 是 C 的 `bool` ⇒ `B`；x86_64 是
    /// `signed char` ⇒ `c`）——两个架构的 IMP 都按 `i8` 读，只有编码串要分开写。
    #[cfg(feature = "gui")]
    fn print_delegate_class() -> Option<Id> {
        if let Some(existing) = class(PRINT_DELEGATE_CLASS) {
            return Some(existing);
        }
        let name = CString::new(PRINT_DELEGATE_CLASS).ok()?;
        let superclass = class("NSObject")?;
        #[cfg(target_arch = "aarch64")]
        let types = "v@:@@B^v";
        #[cfg(not(target_arch = "aarch64"))]
        let types = "v@:@@c^v";
        let types = CString::new(types).ok()?;
        // SAFETY: 只在主线程调用（`print_webview_to_pdf` 的唯一调用点是 `with_webview`），
        // 且"已注册 ⇒ 直接返回"的那一步在分配之前。
        unsafe {
            let cls = objc_allocateClassPair(superclass, name.as_ptr(), 0);
            if cls.is_null() {
                return None; // 并发注册输掉的那一方：类已经存在，但这次拿不到类对象
            }
            let added = class_addMethod(
                cls,
                sel("printOperationDidRun:success:contextInfo:"),
                print_did_run as *const c_void as *mut c_void,
                types.as_ptr(),
            );
            if added == 0 {
                return None;
            }
            objc_registerClassPair(cls);
            Some(cls)
        }
    }

    /// `-runOperationModalForWindow:delegate:didRunSelector:contextInfo:` 的形状
    /// （六个参数、void 返回、**异步**）。
    #[cfg(feature = "gui")]
    unsafe fn msg_void_modal(
        op: Id,
        s: *mut c_void,
        window: Id,
        delegate: Id,
        did_run: *mut c_void,
        ctx: *mut c_void,
    ) {
        let f: unsafe extern "C" fn(Id, *mut c_void, Id, Id, *mut c_void, *mut c_void) =
            unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
        unsafe { f(op, s, window, delegate, did_run, ctx) }
    }

    #[cfg(all(test, feature = "gui"))]
    mod print_tests {
        use super::*;

        /// **无参数、返回 `CGFloat`**（`-topMargin` 这类 getter）。
        ///
        /// ⚠️ 只给单测：产品侧不读边距，它只写。
        unsafe fn msg_f64(receiver: Id, s: *mut c_void) -> f64 {
            let f: unsafe extern "C" fn(Id, *mut c_void) -> f64 =
                unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
            unsafe { f(receiver, s) }
        }

        /// `design/0080` §7.1 第 1 条：三个常量必须真能从运行时取到。
        ///
        /// ⚠️ 它们不是"写死也行"的字面量：`dlsym` 拿到的是**变量地址**，
        /// 少解一层引用就会把一个栈/数据地址当对象用——所以这里连"解出来的东西
        /// 是个非空 `NSString`"一起断言。
        ///
        /// ⚠️ 只断言"非空"，**不断言值长什么样**：2026-11-15 实测 `NSPrintJobDisposition`
        /// 的值是 `"NSJobDisposition"`（**不带** `Print`）——按符号名猜值的第一版断言当场打红。
        /// 那是 AppKit 的**外部事实**，⛔ 别把"看起来应该叫什么"写成判据。
        #[test]
        fn 打印常量能从_dlsym_取到且是真的_NSString() {
            let _pool = Pool::new();
            for name in ["NSPrintJobDisposition", "NSPrintJobSavingURL", "NSPrintSaveJob"] {
                let id = unsafe { dlsym_string(name) }
                    .unwrap_or_else(|| panic!("取不到 `{name}` ⇒ 这台机器上 PDF 导出一定失败"));
                assert!(!id.is_null(), "`{name}` 解引用后是 null");
                let text = nsstring_to_string(id);
                assert!(!text.is_empty(), "`{name}` 不是 NSString（读回来是空串）");
            }
        }

        /// `design/0080` §7.1 第 2 条：自建的 `NSPrintInfo` 设得进去、读得回来；
        /// ⭐ 而且 **`sharedPrintInfo` 的 disposition 一个字节没变**（`INV-PDF-05`）。
        #[test]
        fn NSPrintInfo_设保存作业能读回且不动共享实例() {
            let _pool = Pool::new();
            unsafe {
                let cls = class("NSPrintInfo").expect("拿不到 NSPrintInfo 类");
                // ⚠️ 先记下共享实例的 disposition：下面只允许在**自建**那份上动
                let shared = msg_id(cls, sel("sharedPrintInfo"));
                let before = msg_id(shared, sel("jobDisposition"));

                let info = msg_id(msg_id(cls, sel("alloc")), sel("init"));
                assert!(!info.is_null(), "`[[NSPrintInfo alloc] init]` 返回了 null");

                // ① 边距：写一个**非零**的数再读回来（写 0 读 0 与"默认就是 0"分不开）
                msg_void_f64(info, sel("setTopMargin:"), 12.5);
                assert_eq!(msg_f64(info, sel("topMargin")), 12.5, "`setTopMargin:` 没生效");

                // ② disposition：值在第 1 条里已证明能取到
                let key = dlsym_string("NSPrintJobDisposition").expect("key");
                let save = dlsym_string("NSPrintSaveJob").expect("value");
                let dict = msg_id(info, sel("dictionary"));
                assert!(!dict.is_null(), "`-dictionary` 返回了 null");
                msg_void_id_id(dict, sel("setObject:forKey:"), save, key);
                assert_eq!(
                    msg_id_id(dict, sel("objectForKey:"), key),
                    save,
                    "写进去的 disposition 读不回来 ⇒ 参数顺序或消息形状错了"
                );

                // ③ `INV-PDF-05`：共享实例必须原样
                assert_eq!(
                    msg_id(shared, sel("jobDisposition")),
                    before,
                    "⛔ 共享 NSPrintInfo 被改了：之后任何一次普通打印都会带着保存作业的 disposition"
                );

                release(info);
            }
        }

        /// `bugs/0324`：委托类必须**注册得出、且实例真的认得那个选择器**。
        ///
        /// ⚠️ 判据用 `respondsToSelector:`，⛔ 不是"类对象非空"：
        /// `objc_allocateClassPair` 成功而 `class_addMethod` 失败时（类型编码串写错
        /// 就是这种情形），类照样存在，只是**没有方法**——要到派发那一刻才
        /// `unrecognized selector` 崩掉，而那时用户已经点了导出。
        /// ⚠️ 还断言**幂等**：第二次调用必须拿回同一个类（重名时 `objc_allocateClassPair`
        /// 返回 null，不先查一次就会让第二次导出直接失败）。
        #[test]
        fn 打印委托类认得完成回调选择器且可重复注册() {
            let _pool = Pool::new();
            let a = print_delegate_class().expect("注册委托类失败");
            let b = print_delegate_class().expect("第二次注册拿不到已有的类");
            assert_eq!(a, b, "委托类注册不幂等：第二次拿到了另一个类");
            unsafe {
                let inst = msg_id(msg_id(a, sel("alloc")), sel("init"));
                assert!(!inst.is_null(), "委托实例是 null");
                assert_ne!(
                    msg_bool_sel(
                        inst,
                        sel("respondsToSelector:"),
                        sel("printOperationDidRun:success:contextInfo:")
                    ),
                    0,
                    "委托实例不认完成回调选择器 ⇒ class_addMethod 没生效（类型编码串错了？）"
                );
                release(inst);
            }
        }

        /// `bugs/0324`：完成回调真的把结果送进 channel——**成功和失败都送**。
        ///
        /// ⚠️ 失败那一条同样是判据：调用方靠"收到 `false`"与"根本没人回话"（超时）
        /// 区分两件事；⛔ 不能把 `success = NO` 吞掉，让调用方等满 180 s。
        /// ⚠️ `me` 传 null：这条只测通道，不去 `release` 一个不存在的对象。
        #[test]
        fn 打印完成回调经_channel_送回结果() {
            for (success, expect) in [(1i8, true), (0i8, false)] {
                let (tx, rx) = std::sync::mpsc::channel::<bool>();
                let ctx = Box::into_raw(Box::new(PrintDone { tx, keep: Vec::new() }));
                unsafe {
                    print_did_run(
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        success,
                        ctx as *mut c_void,
                    );
                }
                assert_eq!(
                    rx.recv_timeout(std::time::Duration::from_secs(1)),
                    Ok(expect),
                    "success = {success} 时通道里没有 `{expect}`"
                );
            }
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

    /// ⭐ `design/0083` §2.2：`NSWindowOrderingMode` 的取值只许是 **1 / −1**。
    ///
    /// ⚠️ 这条值得一条单测：`0` 是 `NSWindowOut`（把窗口移出屏幕），**不是** "below"。
    /// 写成 `if above { 1 } else { 0 }` 时：调用方今天只传 `true` ⇒ **一次也踩不到**，
    /// 等哪天有人传 `false`，标签会从屏幕上消失，而 `addTabbedWindow:` 不报任何错。
    #[cfg(all(target_os = "macos", feature = "gui"))]
    #[test]
    fn 并组方向只许是_above_1_与_below_负1() {
        assert_eq!(foundation::ordering_mode(true), 1, "NSWindowAbove");
        assert_eq!(foundation::ordering_mode(false), -1, "NSWindowBelow（⛔ 不是 0 = NSWindowOut）");
        // 负对照：0 是 `NSWindowOut`（把窗口移出屏幕），这一条挡住"写成 0 也绿"。
        assert_ne!(foundation::ordering_mode(false), 0, "0 是 NSWindowOut，不是 below");
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
