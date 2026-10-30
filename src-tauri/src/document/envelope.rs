//! ⭐ **信封**：磁盘正文的**编码与行尾**，与编辑缓冲**分开定义**（`design/0012` §2.4-5 / `INV-EDIT-12`）。
//!
//! # 为什么必须有这一层
//!
//! ⛔ **逐字节保真不能由编辑缓冲承担**——CM6 的文本模型是**行数组**，
//! `@codemirror/state` 的 dist `:608` 一进来就把 `\r` 吃掉
//! （`DefaultSplit = /\r\n?|\n/`，一手取证在 `notes/0016` §「2026-10-15 补充二」①）
//! ⇒ 编辑缓冲里**恒为 LF、无 BOM**，它是**规范化后的**文本，不是原文。
//!
//! 所以"用户一个字都没改"这件事要成立，靠的是**这里**：
//!
//! ```text
//! 磁盘正文 ──normalize──▶ 编辑缓冲（恒 LF / 无 BOM）
//!                              │  用户改字（或没改）
//!                              ▼
//!                          待写字节 ──restore──▶ 与磁盘正文**逐字节**相同
//! ```
//!
//! ⚠️ 两边都是**同一个 `Envelope` 实例**在算——这正是"唯一实现"的落地形式。
//!
//! # ⭐ 一个结构性的一致保证：信封**从基线上判定**，⛔ 不另存一份
//!
//! 打开文件时落进会话的是**基线字节**（`Session::baseline_bytes`，冲突检查要比的那份）。
//! 本模块提供 [`Envelope::detect_raw`]：**从那些字节**判定信封，
//! 而编辑器拿到的缓冲也**由那些字节**产出（[`Envelope::normalize_bytes`]）。
//!
//! ⇒ 于是"保存时用来还原的信封"与"冲突检查用的基线" **必然是同一份字节的两个投影**，
//! ⛔ 不存在"信封是当时记的、基线是后来读的"这种能被改坏的两个真值。
//! ⚠️ 这条由单测 [`tests::字节判定与文本判定必须一致`] 钉住。
//!
//! # 三档行尾，其中一档**明确不承诺保真**
//!
//! | `Eol` | 来源 | 能不能逐字节回写 |
//! |---|---|---|
//! | [`Eol::Lf`] | 全文无 `\r`（含空文件、无尾换行） | ✅ 能 |
//! | [`Eol::CrLf`] | 有 `\r\n` 且**没有**裸 `\r`、**没有**单独的 `\n` | ✅ 能 |
//! | [`Eol::Other`] | 混合行尾 / 裸 `\r` | ⛔ **不承诺**，且**不许静默** |
//!
//! ⚠️ `Other` 那一档的处置是**提示**，不是拒绝：保存后行尾统一为 LF，
//! 界面上常驻一条说明（`design/0012` §2.4-5 / §6）。
//! 这条边界**写在类型里**（[`Envelope::is_lossy`]），⛔ 不靠调用方记得。

use serde::{Deserialize, Serialize};

/// 行尾形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Eol {
    /// 纯 `\n`（**含**空文件与"整篇没有换行符"这两种）。
    #[serde(rename = "lf")]
    Lf,
    /// 纯 `\r\n`。
    #[serde(rename = "crlf")]
    CrLf,
    /// ⚠️ 混合行尾，或存在**裸 `\r`**。⛔ 本模块**不承诺**逐字节回写这一档。
    #[serde(rename = "other")]
    Other,
}

/// 一份文档的编码与行尾。
///
/// ⚠️ **字段只有这两个**，⛔ 不要往里加"缩进风格""末尾空行数"这类东西：
/// 每加一个字段就多一份"必须与磁盘保持一致"的状态，而它**没有自动化防线**
/// （与 `Session::mode()` 拒绝第二个真值是同一条理由）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Envelope {
    /// 原文有没有 UTF-8 BOM。
    pub bom: bool,
    /// 原文的行尾形态。
    pub eol: Eol,
}

/// ⭐ 送到前端的是**三个**键，`lossy` 是**算出来的**。
///
/// ⚠️ 为什么不让前端自己判 `eol === "other"`：那是**本设计的语义**
/// （"这一档不承诺逐字节保真 ⇒ 界面上要常驻一条说明"，`INV-EDIT-12` ②），
/// 抄到前端就等于多一处"改一处忘一处"的判据。⛔ 也**不是**加一个 `lossy` 字段存着：
/// 那就成了第三个可能与 `eol` 不一致的状态（与 [`crate::commands::Session::mode`]
/// 拒绝第二个真值是同一条理由）。
impl Serialize for Envelope {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("Envelope", 3)?;
        st.serialize_field("bom", &self.bom)?;
        st.serialize_field("eol", &self.eol)?;
        st.serialize_field("lossy", &self.is_lossy())?;
        st.end()
    }
}

/// UTF-8 BOM 的三个字节。
///
/// ⚠️ 手写而不是用常量：这件事的**唯一定义**就该在这一行上，
/// 分散到几处 `\u{feff}.as_bytes()` 会让"改一处忘一处"变成静默的编码错误。
const BOM_BYTES: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// ⭐ **把任何文本收敛成 LF**（`\r\n` 与裸 `\r` 一律变 `\n`）。
///
/// ⚠️ 它是**写侧**的无条件防线（[`Envelope::restore`] 用它），
/// ⛔ **不是**两条路上的共用口径——[`Envelope::normalize`] 在 `Lf` 档**刻意**走快路径
/// （那里"没有 `\r`"是**磁盘**给的保证，不必再扫一遍）。两者分开的理由见 `restore`。
fn to_lf(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut it = source.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\r' {
            // `\r\n` 与裸 `\r` **都**收敛成 `\n`
            if it.peek() == Some(&'\n') {
                it.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// ⭐ **行尾扫描**——本模块里"什么算 `Lf` / `CrLf` / `Other`"的**唯一定义**。
///
/// ⚠️ 按**字节**扫而不是按 `char`：`\r` / `\n` 都是单字节，
/// 而 UTF-8 的续字节一律 ≥ `0x80` ⇒ 逐字节扫不会误判多字节字符。
fn scan_eol(body: &[u8]) -> Eol {
    let mut crlf = 0usize; // `\r\n`
    let mut lf = 0usize; // 单独的 `\n`
    let mut cr = 0usize; // 裸 `\r`
    let mut i = 0;
    while i < body.len() {
        match body[i] {
            b'\r' => {
                if i + 1 < body.len() && body[i + 1] == b'\n' {
                    crlf += 1;
                    i += 2;
                } else {
                    cr += 1;
                    i += 1;
                }
            }
            b'\n' => {
                lf += 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    // ⚠️ 判定顺序是**穷尽**的，别改成 `if lf > 0 { Lf }` 那种写法：
    //    裸 `\r` 与混合都要落到 `Other`，而它们都是"看起来正常"的坏形态。
    if cr > 0 || (crlf > 0 && lf > 0) {
        Eol::Other
    } else if crlf > 0 {
        Eol::CrLf
    } else {
        // 到这里 `crlf == 0` 且 `cr == 0` ⇒ 全是 `\n`，或压根没有换行符
        Eol::Lf
    }
}

impl Envelope {
    /// ⭐ **判定（来自 `loader`）**。输入是 `loader::load` 的两样产物：
    /// `source`（**已剥 BOM**，但 `\r` **还在**）与 `had_bom`。
    pub fn detect(source: &str, had_bom: bool) -> Self {
        Envelope { bom: had_bom, eol: scan_eol(source.as_bytes()) }
    }

    /// ⭐ **判定（来自字节）**——写侧与 `begin_edit` 用的就是这一条。
    ///
    /// ⚠️ 它与 [`detect`](Self::detect) **共用** [`scan_eol`]，
    /// ⛔ 不是"另一套实现"；两者的等价性由单测钉住。
    pub fn detect_raw(raw: &[u8]) -> Self {
        match raw.strip_prefix(&BOM_BYTES) {
            Some(body) => Envelope { bom: true, eol: scan_eol(body) },
            None => Envelope { bom: false, eol: scan_eol(raw) },
        }
    }

    /// ⭐ **磁盘正文（字节） ⇒ 编辑缓冲**（恒 LF、无 BOM）。
    ///
    /// ⚠️ 基线的字节**必然**是合法 UTF-8：它出自
    /// [`raw_bytes`](Self::raw_bytes)，而那里的入参是 `String`。
    /// ⇒ 那个 `Err` 分支**结构上不可达**，留着是为了⛔ 不写 `unwrap`
    /// （`unwrap` 在"不可能发生"的地方是最糟的一种：真发生时是 panic 而不是一条日志）。
    pub fn normalize_bytes(&self, raw: &[u8]) -> Result<String, String> {
        let body = if self.bom {
            raw.strip_prefix(&BOM_BYTES).unwrap_or(raw)
        } else {
            raw
        };
        let text = std::str::from_utf8(body)
            .map_err(|e| format!("基线不是合法 UTF-8（偏移 {}）", e.valid_up_to()))?;
        Ok(self.normalize(text))
    }

    /// ⭐ **磁盘正文（`loader` 的 `source`） ⇒ 编辑缓冲**。
    ///
    /// ⚠️ BOM **不在这里剥**——`loader::load` 已经剥过了（`loader.rs:46-49`），
    /// 再剥一次就是**两份实现**，而两份实现迟早对不齐。
    ///
    /// ⚠️ **方向只说一个**：输入必须来自**磁盘**（或由它反推的基线）。
    /// `Lf` 档那条快路径**信任**"没有 `\r`"，而这份信任只对磁盘上的字节成立——
    /// ⛔ 前端来的缓冲要走 [`restore`](Self::restore)，那里**无条件**收敛。
    pub fn normalize(&self, source: &str) -> String {
        if self.eol == Eol::Lf {
            // ⚠️ 快路径：绝大多数文件走这里，省一次逐字符重建。
            //    `Lf` 档的定义就是"没有 `\r`"，所以这里不做扫描是有依据的。
            return source.to_owned();
        }
        to_lf(source)
    }

    /// ⭐ **编辑缓冲 ⇒ 待写字节**（加回行尾与 BOM）。**这是写侧的唯一定义**。
    ///
    /// ⚠️ 先做一次**防御性收敛**：缓冲里的 `\r\n` / 裸 `\r` 一律变 `\n`。
    /// 理由是"写出去的文件里**永远不出现裸 `\r`**"这条性质值得**无条件**成立——
    /// 缓冲本该已是 LF（CM6 的 `Text` 保证），但 `text` 参数是从前端来的，
    /// ⛔ 不该让一个出错的前端把裸 `\r` 写进用户的文件。
    /// ✅ 对本设计自己的缓冲（恒 LF）这一步是**恒等变换**，没有副作用
    /// （单测 [`tests::restore_对出错前端的裸_cr_做收敛`] 两个方向都测）。
    ///
    /// ⚠️⚠️ **这里走 [`to_lf`]，⛔ 不是 `self.normalize`**——`normalize` 的 `Lf` 快路径
    /// **信任**输入没有 `\r`，而"无条件收敛"正是不信任。⭐ 一开始写成了 `self.normalize`，
    /// 于是 `Lf` 档的文件会把前端缓冲里的 `\r` **原样写出去**；
    /// 是上面那条单测把它抓出来的（⛔ 不是靠读代码看出来的）。
    pub fn restore(&self, buffer: &str) -> Vec<u8> {
        let lf = to_lf(buffer);
        let body: Vec<u8> = match self.eol {
            // ⛔ `Other` 也走这一支：保存后统一为 LF（这就是那条常驻提示说的内容）
            Eol::Lf | Eol::Other => lf.into_bytes(),
            Eol::CrLf => {
                let mut v = Vec::with_capacity(lf.len() + 16);
                for &byte in lf.as_bytes() {
                    if byte == b'\n' {
                        v.push(b'\r');
                    }
                    v.push(byte);
                }
                v
            }
        };
        if !self.bom {
            return body;
        }
        let mut v = Vec::with_capacity(body.len() + BOM_BYTES.len());
        v.extend_from_slice(&BOM_BYTES);
        v.extend_from_slice(&body);
        v
    }

    /// ⭐ **磁盘原文的字节**——由 `loader::load` 的两样产物**精确反推**。
    ///
    /// ⚠️ 这是"精确"而不是"近似"，理由很具体：`loader::load` 只做了一件事
    /// ——`text.strip_prefix('\u{feff}')`（`loader.rs:46`），而 BOM 在 UTF-8 里
    /// 就是那固定的三个字节。⇒ 反过来拼回去必然逐字节相等。
    ///
    /// ⭐ 它的用途是 §2.4-3 的**内容级基线**（冲突检查比的是**内容**，
    /// ⛔ 不是 mtime/len）⇒ 它**承担正确性**，所以宁可在这里反推，
    /// ⛔ 也不要为了它多读一次盘（多一次读 = 多一个 TOCTOU 窗口）。
    ///
    /// ⚠️ 收 `String`（**按值**）而不是 `&str`：调用方手上的 `source` 到那一刻
    /// 已经没有别的用处了，按值传让无 BOM 这个**绝大多数**的分支
    /// （`into_bytes()`）**零拷贝**。多写一个 `.to_string()` 换一次 10 MB 的拷贝，不值。
    pub fn raw_bytes(source: String, had_bom: bool) -> Vec<u8> {
        if !had_bom {
            return source.into_bytes();
        }
        let mut v = Vec::with_capacity(source.len() + BOM_BYTES.len());
        v.extend_from_slice(&BOM_BYTES);
        v.extend_from_slice(source.as_bytes());
        v
    }

    /// ⭐ **这一档要不要向用户显式提示**（`INV-EDIT-12` ②）。
    ///
    /// ⚠️ 写在类型里而不是让前端自己判 `eol === "other"`：
    /// 那条判据是**本设计的语义**，⛔ 不该让每个调用点各抄一遍。
    pub fn is_lossy(&self) -> bool {
        self.eol == Eol::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⭐ **7 类样本**（`design/0012` §7 步骤 0e 的那张表）。
    /// ⚠️ `restorable` 是**期望值**，⛔ 不是"能跑通就行"——
    /// `Other` 两类的期望就是 `false`，把它们写成 `true` 会让这条测试失去意义。
    struct Sample {
        name: &'static str,
        body: &'static str,
        bom: bool,
        eol: Eol,
        restorable: bool,
    }

    const SAMPLES: &[Sample] = &[
        Sample { name: "lf", body: "a\nb\n", bom: false, eol: Eol::Lf, restorable: true },
        Sample { name: "crlf", body: "a\r\nb\r\n", bom: false, eol: Eol::CrLf, restorable: true },
        Sample { name: "bom+crlf", body: "a\r\nb\r\n", bom: true, eol: Eol::CrLf, restorable: true },
        Sample {
            name: "no-trailing-newline",
            body: "# 标题\n正文",
            bom: false,
            eol: Eol::Lf,
            restorable: true,
        },
        Sample { name: "empty", body: "", bom: false, eol: Eol::Lf, restorable: true },
        Sample { name: "mixed", body: "a\r\nb\nc", bom: false, eol: Eol::Other, restorable: false },
        Sample { name: "bare-cr", body: "a\rb", bom: false, eol: Eol::Other, restorable: false },
    ];

    fn raw(s: &Sample) -> Vec<u8> {
        Envelope::raw_bytes(s.body.to_string(), s.bom)
    }

    /// ⚠️ 测试里**故意用另一条路**拼原文（`BOM ++ body`），而不是复用
    /// `Envelope::raw_bytes`——否则"反推对不对"这件事就成了自己验自己。
    fn split_bom(body: &str, bom: bool) -> Vec<u8> {
        let mut v: Vec<u8> = Vec::new();
        if bom {
            v.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        v.extend_from_slice(body.as_bytes());
        v
    }

    #[test]
    fn 七类样本的判定与还原() {
        for s in SAMPLES {
            let env = Envelope::detect(s.body, s.bom);
            assert_eq!(env.eol, s.eol, "样本 {} 的 Eol 判错：{:?}", s.name, env.eol);
            assert_eq!(env.bom, s.bom, "样本 {} 的 BOM 判错", s.name);
            assert_eq!(env.is_lossy(), !s.restorable, "样本 {} 的 is_lossy 与期望不符", s.name);

            // ⚠️ 基线反推必须**逐字节**等于磁盘原文——7 类都要求，
            //    因为它是**冲突检查**的口径，与"能不能回写"是两件事。
            assert_eq!(raw(s), split_bom(s.body, s.bom), "样本 {}：基线反推应逐字节等于原文", s.name);

            if s.restorable {
                // ⭐ `Lf` / `CrLf`：**空改动必须逐字节回写**
                assert_eq!(
                    raw(s),
                    env.restore(&env.normalize(s.body)),
                    "样本 {}：空改动应逐字节相同",
                    s.name
                );
            } else {
                // ⭐ `Other` 这一档：⛔ 不承诺逐字节，但**必须**收敛成纯 LF
                let out = env.restore(&env.normalize(s.body));
                assert!(!out.contains(&b'\r'), "样本 {}：Other 档写出的字节里不该有 \\r", s.name);
            }
        }
    }

    /// ⭐ 写侧判信封与打开时判信封**必须一致**——这是"信封从基线判定"那条保证的机器判据。
    #[test]
    fn 字节判定与文本判定必须一致() {
        for s in SAMPLES {
            let from_text = Envelope::detect(s.body, s.bom);
            let from_bytes = Envelope::detect_raw(&raw(s));
            assert_eq!(from_text, from_bytes, "样本 {}：两条判定路径分叉了", s.name);
            // ⭐ 而"从基线取回缓冲"必须与"从 source 取缓冲"逐字节相同
            let a = from_bytes.normalize_bytes(&raw(s)).expect("基线必然是合法 UTF-8");
            let b = from_text.normalize(s.body);
            assert_eq!(a, b, "样本 {}：缓冲的两条产出路径分叉了", s.name);
        }
    }

    #[test]
    fn other_档确实与原文不同_所以不许声称可还原() {        // ⚠️ 这条测试是**反面证据**：如果哪天 `Other` 也能逐字节回写，
        //    说明判定或还原被改动了，那时 §2.4-5 的整段论证要重读。
        for s in SAMPLES.iter().filter(|s| !s.restorable) {
            let env = Envelope::detect(s.body, s.bom);
            assert_ne!(
                raw(s),
                env.restore(&env.normalize(s.body)),
                "样本 {}：Other 档居然逐字节相同了——判定可能已经失效",
                s.name
            );
        }
    }

    #[test]
    fn bom_有无两向都测() {
        let no_bom = Envelope::detect("a\n", false);
        let with_bom = Envelope::detect("a\n", true);
        assert_eq!(no_bom.restore("a\n"), b"a\n".to_vec());
        assert_eq!(with_bom.restore("a\n"), vec![0xEF, 0xBB, 0xBF, b'a', b'\n']);
        // ⚠️ 方向二：BOM 不能被"顺手带上"，也不能被丢掉
        assert_eq!(Envelope::raw_bytes("a\n".to_string(), true).len(), 5);
        assert_eq!(Envelope::raw_bytes("a\n".to_string(), false).len(), 2);
        // ⚠️ 方向三：`detect_raw` 也要认出 BOM
        assert!(Envelope::detect_raw(&[0xEF, 0xBB, 0xBF, b'a']).bom);
        assert!(!Envelope::detect_raw(b"a").bom);
    }

    #[test]
    fn 空文件判成_lf_且还原为空() {
        let env = Envelope::detect("", false);
        assert_eq!(env.eol, Eol::Lf);
        assert!(env.restore("").is_empty());
        assert!(!env.is_lossy());
    }

    #[test]
    fn 只有裸_cr_判成_other() {
        // ⚠️ 单看"没有 `\n`"容易被误判成"无换行 ⇒ Lf"——
        //    裸 `\r` 是**老 Mac 行尾**，改完就丢，所以必须落 `Other`。
        assert_eq!(Envelope::detect("a\rb", false).eol, Eol::Other);
        assert_eq!(Envelope::detect("a\rb\n", false).eol, Eol::Other);
    }

    #[test]
    fn crlf_文件里的裸_cr_仍然判_other() {
        assert_eq!(Envelope::detect("a\r\nb\rc", false).eol, Eol::Other);
    }

    #[test]
    fn normalize_是幂等的() {
        for s in SAMPLES {
            let env = Envelope::detect(s.body, s.bom);
            let once = env.normalize(s.body);
            assert_eq!(env.normalize(&once), once, "样本 {}：normalize 不幂等", s.name);
        }
    }

    #[test]
    fn restore_对出错前端的裸_cr_做收敛() {
        // ⚠️ 缓冲本该是 LF（CM6 保证），但 `text` 从前端来 ⇒ 防御性收敛。
        let env = Envelope::detect("a\nb\n", false);
        assert_eq!(env.restore("a\r\nb\r"), b"a\nb\n".to_vec());
        // ⚠️ CRLF 文件 + 带 `\r` 的缓冲 ⇒ 每个 `\n` 前恰好一个 `\r`，⛔ 不能出现 `\r\r\n`
        let crlf = Envelope::detect("a\r\nb\r\n", false);
        assert_eq!(crlf.restore("a\r\nb\r"), b"a\r\nb\r\n".to_vec());
    }

    #[test]
    fn 多字节字符不会被行尾扫描误判() {
        // ⚠️ 这条守的是"按字节扫"的正确性：中文与 emoji 的字节都 ≥ 0x80，
        //    但只要有哪一个恰好等于 `\r`/`\n` 的写法存在，这里就会红。
        let body = "中文\r\nEmoji 🙂\r\n末尾";
        let env = Envelope::detect(body, false);
        assert_eq!(env.eol, Eol::CrLf);
        assert_eq!(raw(&Sample { name: "x", body, bom: false, eol: Eol::CrLf, restorable: true }),
                   env.restore(&env.normalize(body)));
    }

    /// ⭐ 送前端的形状（`INV-EDIT-12` ②）：**三个键**，`lossy` 由 `eol` 算出。
    ///
    /// ⚠️ 判据是"`lossy` 与 `eol` **一定**同向"——只断言某个样本的 `lossy` 是
    /// `true`/`false` 会让"`lossy` 被写成常量"这种情况照样绿。
    #[test]
    fn 序列化形状是三个键且_lossy_与_eol_同向() {
        for s in SAMPLES {
            let env = Envelope::detect(s.body, s.bom);
            let v: serde_json::Value = serde_json::to_value(env).unwrap();
            let obj = v.as_object().expect("必须是一个对象");
            assert_eq!(obj.len(), 3, "样本 {}：键数不是 3 —— 多了会漂、少了前端判不了", s.name);
            assert_eq!(obj["bom"], serde_json::json!(s.bom), "样本 {}", s.name);
            assert_eq!(obj["lossy"], serde_json::json!(!s.restorable), "样本 {}", s.name);
            // ⚠️ 前端按字符串分支（⛔ 不是数字、⛔ 不是 Rust 的变体名）
            let want = match s.eol {
                Eol::Lf => "lf",
                Eol::CrLf => "crlf",
                Eol::Other => "other",
            };
            assert_eq!(obj["eol"], serde_json::json!(want), "样本 {}", s.name);
        }
    }
}
