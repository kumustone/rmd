<!-- 由 `scripts/gen-third-party.py` 生成，⛔ 不要手改；改规则请改脚本后重跑 `make third-party`。 -->

# 第三方声明 / Third-Party Notices

本文件列出 rmd 分发产物中包含的第三方组件及其许可证。

> ⭐ **rmd 自身采用 GPL-3.0-or-later**（2026-10-23 拍板，见仓库根 `LICENSE`）。
> ⚠️ 二进制里链着 GPL-3.0-or-later 的 `flowmaid`——**与项目许可证相同 ⇒ 相容**；
> 分发时按 GPL 随附源码即可，不再是阻断项。

## 1 这份清单是怎么来的

```bash
make third-party        # = python3 scripts/gen-third-party.py
make check-third-party  # 只校验：磁盘上的这份与「现在重新生成」逐字节相同
```

- **Rust 侧**：`cargo metadata --locked --features gui --filter-platform aarch64-apple-darwin`。
  ⚠️ 带 `--features gui` 是因为 `tauri` / `notify` / `muda` 是 optional 依赖；
  不带它会漏掉整棵 GUI 依赖树。`--filter-platform` 只保留该目标上真会编译的包。
- **npm 侧**：从 `package.json` 的 `dependencies` 出发，在 `node_modules/` 里递归收集。
  `devDependencies`（只有 `esbuild`）只在构建期用，产出里不含它的代码，单列在 §6。
- ⛔ **不联网**：两个来源都是本机已有的锁文件 / 已安装包。

## 2 ⚠️ 必须由人拍板：与项目许可证不相容的依赖

无。所有依赖都可以随 rmd 一起按 GPL-3.0-or-later 分发（GPL-3 系著佐权组件见 §3 的「随附源码」义务）。

## 3 需要保留声明的许可证（非阻断，但有义务）

| 组件 | 许可证 | 义务 |
|---|---|---|
| `cssparser 0.37.0` | MPL-2.0 | 文件级弱著佐权：分发时须提供被修改文件的源码（本项目未修改它们） |
| `cssparser-macros 0.7.1` | MPL-2.0 | 文件级弱著佐权：分发时须提供被修改文件的源码（本项目未修改它们） |
| `dtoa-short 0.3.5` | MPL-2.0 | 文件级弱著佐权：分发时须提供被修改文件的源码（本项目未修改它们） |
| `finl_unicode 1.5.0` | (MIT OR Apache-2.0) AND Unicode-DFS-2016 | 须随分发附带 Unicode 许可证与版权声明 |
| `flowmaid 0.27.0` | GPL-3.0-or-later | GPL-3.0-or-later：项目自身即 GPL-3.0-or-later ⇒ **相容**，分发时须随附源码与许可证 |
| `icu_collections 2.3.0` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `icu_locale_core 2.3.0` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `icu_normalizer 2.3.0` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `icu_normalizer_data 2.3.0` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `icu_properties 2.3.0` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `icu_properties_data 2.3.0` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `icu_provider 2.3.1` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `litemap 0.8.3` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `option-ext 0.2.0` | MPL-2.0 | 文件级弱著佐权：分发时须提供被修改文件的源码（本项目未修改它们） |
| `potential_utf 0.1.6` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `selectors 0.38.0` | MPL-2.0 | 文件级弱著佐权：分发时须提供被修改文件的源码（本项目未修改它们） |
| `tinystr 0.8.4` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `unicode-ident 1.0.27` | (MIT OR Apache-2.0) AND Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `writeable 0.6.4` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `yoke 0.8.3` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `yoke-derive 0.8.4` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `zerofrom 0.1.8` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `zerofrom-derive 0.1.8` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `zerotrie 0.2.5` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `zerovec 0.11.8` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |
| `zerovec-derive 0.11.6` | Unicode-3.0 | 须随分发附带 Unicode 许可证与版权声明 |

⚠️ 上表的义务是**逐条**的：MPL-2.0 只约束它自己的那几个源文件，
不要求 rmd 整体换许可证；Unicode 那几条要求随分发附带许可证与版权声明。

⚠️ **尚未做到**：分发包里还没有随附各许可证的**全文**。
这项工作属于打包环节（DMG 里放 `LICENSES/`），是首个二进制发布前的待办。

## 4 Rust 依赖（`aarch64-apple-darwin`，`--features gui`）

共 **283** 个第三方 crate。

| 包 | 版本 | 许可证 | 上游仓库 |
|---|---|---|---|
| `adler2` | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | https://github.com/oyvindln/adler2 |
| `aho-corasick` | 1.1.5 | Unlicense OR MIT | https://github.com/BurntSushi/aho-corasick |
| `alloc-no-stdlib` | 3.0.0 | BSD-3-Clause | https://github.com/dropbox/rust-alloc-no-stdlib |
| `alloc-stdlib` | 0.3.0 | BSD-3-Clause | https://github.com/dropbox/rust-alloc-no-stdlib |
| `anstream` | 1.0.0 | MIT OR Apache-2.0 | https://github.com/rust-cli/anstyle.git |
| `anstyle` | 1.0.14 | MIT OR Apache-2.0 | https://github.com/rust-cli/anstyle.git |
| `anstyle-parse` | 1.0.0 | MIT OR Apache-2.0 | https://github.com/rust-cli/anstyle.git |
| `anstyle-query` | 1.1.5 | MIT OR Apache-2.0 | https://github.com/rust-cli/anstyle.git |
| `anyhow` | 1.0.104 | MIT OR Apache-2.0 | https://github.com/dtolnay/anyhow |
| `autocfg` | 1.5.1 | Apache-2.0 OR MIT | https://github.com/cuviper/autocfg |
| `base64` | 0.21.7 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| `base64` | 0.23.1 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| `bincode` | 1.3.3 | MIT | https://github.com/servo/bincode |
| `bit-set` | 0.8.0 | Apache-2.0 OR MIT | https://github.com/contain-rs/bit-set |
| `bit-vec` | 0.8.0 | Apache-2.0 OR MIT | https://github.com/contain-rs/bit-vec |
| `bitflags` | 1.3.2 | MIT/Apache-2.0 | https://github.com/bitflags/bitflags |
| `bitflags` | 2.13.2 | MIT OR Apache-2.0 | https://github.com/bitflags/bitflags |
| `block-buffer` | 0.10.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `block2` | 0.6.2 | MIT | https://github.com/madsmtm/objc2 |
| `bon` | 3.10.2 | MIT OR Apache-2.0 | https://github.com/elastio/bon |
| `bon-macros` | 3.10.2 | MIT OR Apache-2.0 | https://github.com/elastio/bon |
| `brotli` | 9.0.0 | BSD-3-Clause AND MIT | https://github.com/dropbox/rust-brotli |
| `brotli-decompressor` | 6.0.1 | BSD-3-Clause/MIT | https://github.com/dropbox/rust-brotli-decompressor |
| `bs58` | 0.5.1 | MIT/Apache-2.0 | https://github.com/Nullus157/bs58-rs |
| `byteorder` | 1.5.0 | Unlicense OR MIT | https://github.com/BurntSushi/byteorder |
| `bytes` | 1.12.1 | MIT | https://github.com/tokio-rs/bytes |
| `camino` | 1.2.6 | MIT OR Apache-2.0 | https://github.com/camino-rs/camino |
| `cargo-platform` | 0.1.9 | MIT OR Apache-2.0 | https://github.com/rust-lang/cargo |
| `cargo_metadata` | 0.19.2 | MIT | https://github.com/oli-obk/cargo_metadata |
| `cargo_toml` | 1.0.1 | Apache-2.0 OR MIT | https://gitlab.com/lib.rs/cargo_toml |
| `caseless` | 0.2.2 | MIT | https://github.com/unicode-rs/rust-caseless |
| `cc` | 1.8.0 | MIT OR Apache-2.0 | https://github.com/rust-lang/cc-rs |
| `cfb` | 0.14.0 | MIT | https://github.com/mdsteele/rust-cfb |
| `cfg-if` | 1.0.5 | MIT OR Apache-2.0 | https://github.com/rust-lang/cfg-if |
| `chrono` | 0.4.45 | MIT OR Apache-2.0 | https://github.com/chronotope/chrono |
| `clap` | 4.6.7 | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| `clap_builder` | 4.6.7 | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| `clap_derive` | 4.6.7 | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| `clap_lex` | 1.1.1 | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| `colorchoice` | 1.0.5 | MIT OR Apache-2.0 | https://github.com/rust-cli/anstyle.git |
| `comrak` | 0.56.0 | BSD-2-Clause | https://github.com/kivikakk/comrak |
| `cookie` | 0.18.2 | MIT OR Apache-2.0 | https://github.com/SergioBenitez/cookie-rs |
| `core-foundation` | 0.10.1 | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| `core-foundation-sys` | 0.8.7 | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| `core-graphics` | 0.25.0 | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| `core-graphics-types` | 0.2.0 | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| `cpufeatures` | 0.2.17 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `crc32fast` | 1.5.2 | MIT OR Apache-2.0 | https://github.com/srijs/rust-crc32fast |
| `crossbeam-channel` | 0.5.17 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| `crossbeam-utils` | 0.8.23 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| `crypto-common` | 0.1.7 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `cssparser` | 0.37.0 | MPL-2.0 | https://github.com/servo/rust-cssparser |
| `cssparser-macros` | 0.7.1 | MPL-2.0 | https://github.com/servo/rust-cssparser |
| `ctor` | 1.0.13 | Apache-2.0 OR MIT | https://github.com/mmastrac/linktime |
| `darling` | 0.24.1 | MIT | https://github.com/TedDriggs/darling |
| `darling_core` | 0.24.1 | MIT | https://github.com/TedDriggs/darling |
| `darling_macro` | 0.24.1 | MIT | https://github.com/TedDriggs/darling |
| `defmt` | 1.1.1 | MIT OR Apache-2.0 | https://github.com/knurling-rs/defmt |
| `defmt-macros` | 1.1.1 | MIT OR Apache-2.0 | https://github.com/knurling-rs/defmt |
| `defmt-parser` | 1.0.0 | MIT OR Apache-2.0 | https://github.com/knurling-rs/defmt |
| `deranged` | 0.5.8 | MIT OR Apache-2.0 | https://github.com/jhpratt/deranged |
| `derive_more` | 2.1.1 | MIT | https://github.com/JelteF/derive_more |
| `derive_more-impl` | 2.1.1 | MIT | https://github.com/JelteF/derive_more |
| `digest` | 0.10.7 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `dirs` | 7.0.0 | MIT OR Apache-2.0 | https://codeberg.org/dirs/dirs-rs |
| `dirs-sys` | 0.5.0 | MIT OR Apache-2.0 | https://github.com/dirs-dev/dirs-sys-rs |
| `dispatch2` | 0.3.1 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| `displaydoc` | 0.2.7 | MIT OR Apache-2.0 | https://github.com/yaahc/displaydoc |
| `dom_query` | 0.28.0 | MIT | https://github.com/niklak/dom_query |
| `dpi` | 0.1.2 | Apache-2.0 AND MIT | https://github.com/rust-windowing/winit |
| `dtoa` | 1.0.11 | MIT OR Apache-2.0 | https://github.com/dtolnay/dtoa |
| `dtoa-short` | 0.3.5 | MPL-2.0 | https://github.com/upsuper/dtoa-short |
| `dunce` | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | https://gitlab.com/kornelski/dunce |
| `dyn-clone` | 1.0.20 | MIT OR Apache-2.0 | https://github.com/dtolnay/dyn-clone |
| `embed-resource` | 3.0.12 | MIT | https://github.com/nabijaczleweli/rust-embed-resource |
| `embed_plist` | 1.2.2 | MIT OR Apache-2.0 | https://github.com/nvzqz/embed-plist-rs |
| `entities` | 1.0.1 | MIT | https://github.com/p-jackson/entities |
| `equivalent` | 1.0.2 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/equivalent |
| `erased-serde` | 0.4.10 | MIT OR Apache-2.0 | https://github.com/dtolnay/erased-serde |
| `fancy-regex` | 0.16.2 | MIT | https://github.com/fancy-regex/fancy-regex |
| `fastrand` | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/fastrand |
| `fdeflate` | 0.3.7 | MIT OR Apache-2.0 | https://github.com/image-rs/fdeflate |
| `fearless_simd` | 1.1.0 | Apache-2.0 OR MIT | https://github.com/linebender/fearless_simd |
| `fearless_simd_macros` | 0.1.0 | Apache-2.0 OR MIT | https://github.com/linebender/fearless_simd |
| `find-msvc-tools` | 0.1.14 | MIT OR Apache-2.0 | https://github.com/rust-lang/cc-rs |
| `finl_unicode` | 1.5.0 | (MIT OR Apache-2.0) AND Unicode-DFS-2016 | https://github.com/dahosek/finl_unicode |
| `flate2` | 1.1.10 | MIT OR Apache-2.0 | https://github.com/rust-lang/flate2-rs |
| `flowmaid` | 0.27.0 | GPL-3.0-or-later | https://github.com/go-routine-id/flowmaid |
| `fnv` | 1.0.7 | Apache-2.0 / MIT | https://github.com/servo/rust-fnv |
| `foldhash` | 0.2.0 | Zlib | https://github.com/orlp/foldhash |
| `foreign-types` | 0.5.0 | MIT/Apache-2.0 | https://github.com/sfackler/foreign-types |
| `foreign-types-macros` | 0.2.4 | MIT/Apache-2.0 | https://github.com/sfackler/foreign-types |
| `foreign-types-shared` | 0.3.1 | MIT/Apache-2.0 | https://github.com/sfackler/foreign-types |
| `form_urlencoded` | 1.2.2 | MIT OR Apache-2.0 | https://github.com/servo/rust-url |
| `fsevent-sys` | 4.1.0 | MIT | https://github.com/octplane/fsevent-rust/tree/master/fsevent-sys |
| `generic-array` | 0.14.7 | MIT | https://github.com/fizyk20/generic-array.git |
| `getrandom` | 0.3.4 | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| `getrandom` | 0.4.3 | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| `glob` | 0.3.4 | MIT OR Apache-2.0 | https://github.com/rust-lang/glob |
| `hashbrown` | 0.12.3 | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| `hashbrown` | 0.17.1 | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| `heck` | 0.5.0 | MIT OR Apache-2.0 | https://github.com/withoutboats/heck |
| `hex` | 0.4.3 | MIT OR Apache-2.0 | https://github.com/KokaKiwi/rust-hex |
| `html5ever` | 0.39.0 | MIT OR Apache-2.0 | https://github.com/servo/html5ever |
| `http` | 1.5.0 | MIT OR Apache-2.0 | https://github.com/hyperium/http |
| `iana-time-zone` | 0.1.65 | MIT OR Apache-2.0 | https://github.com/strawlab/iana-time-zone |
| `ico` | 0.5.0 | MIT | https://github.com/mdsteele/rust-ico |
| `icu_collections` | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_locale_core` | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_normalizer` | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_normalizer_data` | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_properties` | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_properties_data` | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_provider` | 2.3.1 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `ident_case` | 1.0.1 | MIT/Apache-2.0 | https://github.com/TedDriggs/ident_case |
| `idna` | 1.1.0 | MIT OR Apache-2.0 | https://github.com/servo/rust-url/ |
| `idna_adapter` | 1.2.2 | Apache-2.0 OR MIT | https://github.com/hsivonen/idna_adapter |
| `indexmap` | 1.9.3 | Apache-2.0 OR MIT | https://github.com/bluss/indexmap |
| `indexmap` | 2.14.2 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/indexmap |
| `infer` | 0.22.0 | MIT | https://github.com/bojand/infer |
| `is_terminal_polyfill` | 1.70.2 | MIT OR Apache-2.0 | https://github.com/polyfill-rs/is_terminal_polyfill |
| `itoa` | 1.0.18 | MIT OR Apache-2.0 | https://github.com/dtolnay/itoa |
| `jiff` | 0.2.38 | Unlicense OR MIT | https://github.com/BurntSushi/jiff |
| `jiff-core` | 0.1.1 | Unlicense OR MIT | https://github.com/BurntSushi/jiff |
| `json-patch` | 4.2.0 | MIT/Apache-2.0 | https://github.com/idubrov/json-patch |
| `jsonptr` | 0.7.1 | MIT OR Apache-2.0 | https://github.com/chanced/jsonptr |
| `katex-rs` | 0.3.0 | MIT | https://github.com/katex-rs/katex-rs |
| `keyboard-types` | 0.8.3 | MIT OR Apache-2.0 | https://github.com/rust-windowing/keyboard-types |
| `libc` | 0.2.190 | MIT OR Apache-2.0 | https://github.com/rust-lang/libc |
| `litemap` | 0.8.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `lock_api` | 0.4.14 | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| `log` | 0.4.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/log |
| `markup5ever` | 0.39.0 | MIT OR Apache-2.0 | https://github.com/servo/html5ever |
| `memchr` | 2.8.3 | Unlicense OR MIT | https://github.com/BurntSushi/memchr |
| `memchr-n` | 0.1.9 | MIT OR Apache-2.0 | https://github.com/Dr-Emann/memchr_n |
| `mime` | 0.3.17 | MIT OR Apache-2.0 | https://github.com/hyperium/mime |
| `miniz_oxide` | 0.8.9 | MIT OR Zlib OR Apache-2.0 | https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| `miniz_oxide` | 0.9.1 | MIT OR Zlib OR Apache-2.0 | https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| `mio` | 1.2.4 | MIT | https://github.com/tokio-rs/mio |
| `muda` | 0.20.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/muda |
| `new_debug_unreachable` | 1.0.6 | MIT | https://github.com/mbrubeck/rust-debug-unreachable |
| `notify` | 8.2.0 | CC0-1.0 | https://github.com/notify-rs/notify.git |
| `notify-types` | 2.1.0 | MIT OR Apache-2.0 | https://github.com/notify-rs/notify.git |
| `num-conv` | 0.2.2 | MIT OR Apache-2.0 | https://github.com/jhpratt/num-conv |
| `num-traits` | 0.2.19 | MIT OR Apache-2.0 | https://github.com/rust-num/num-traits |
| `objc2` | 0.6.5 | MIT | https://github.com/madsmtm/objc2 |
| `objc2-app-kit` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| `objc2-core-foundation` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| `objc2-core-graphics` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| `objc2-encode` | 4.1.0 | MIT | https://github.com/madsmtm/objc2 |
| `objc2-exception-helper` | 0.1.1 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| `objc2-foundation` | 0.3.2 | MIT | https://github.com/madsmtm/objc2 |
| `objc2-io-surface` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| `objc2-quartz-core` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| `objc2-web-kit` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| `once_cell` | 1.21.4 | MIT OR Apache-2.0 | https://github.com/matklad/once_cell |
| `option-ext` | 0.2.0 | MPL-2.0 | https://github.com/soc/option-ext.git |
| `parking_lot` | 0.12.5 | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| `parking_lot_core` | 0.9.12 | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| `percent-encoding` | 2.3.2 | MIT OR Apache-2.0 | https://github.com/servo/rust-url/ |
| `phf` | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| `phf` | 0.14.0 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_codegen` | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_codegen` | 0.14.0 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_generator` | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_generator` | 0.14.0 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_macros` | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_macros` | 0.14.0 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_shared` | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_shared` | 0.14.0 | MIT | https://github.com/rust-phf/rust-phf |
| `pin-project-lite` | 0.2.17 | Apache-2.0 OR MIT | https://github.com/taiki-e/pin-project-lite |
| `plist` | 1.10.1 | MIT | https://github.com/ebarnard/rust-plist/ |
| `png` | 0.17.16 | MIT OR Apache-2.0 | https://github.com/image-rs/image-png |
| `png` | 0.18.1 | MIT OR Apache-2.0 | https://github.com/image-rs/image-png |
| `potential_utf` | 0.1.6 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `powerfmt` | 0.2.1 | MIT OR Apache-2.0 | https://github.com/jhpratt/powerfmt |
| `precomputed-hash` | 0.1.1 | MIT | https://github.com/emilio/precomputed-hash |
| `prettyplease` | 0.3.0 | MIT OR Apache-2.0 | https://github.com/dtolnay/prettyplease |
| `proc-macro2` | 1.0.107 | MIT OR Apache-2.0 | https://github.com/dtolnay/proc-macro2 |
| `quick-xml` | 0.42.0 | MIT | https://github.com/tafia/quick-xml |
| `quote` | 1.0.47 | MIT OR Apache-2.0 | https://github.com/dtolnay/quote |
| `rapidhash` | 4.5.1 | MIT OR Apache-2.0 | https://github.com/hoxxep/rapidhash |
| `raw-window-handle` | 0.6.2 | MIT OR Apache-2.0 OR Zlib | https://github.com/rust-windowing/raw-window-handle |
| `ref-cast` | 1.0.27 | MIT OR Apache-2.0 | https://github.com/dtolnay/ref-cast |
| `ref-cast-impl` | 1.0.27 | MIT OR Apache-2.0 | https://github.com/dtolnay/ref-cast |
| `regex` | 1.13.1 | MIT OR Apache-2.0 | https://github.com/rust-lang/regex |
| `regex-automata` | 0.4.18 | MIT OR Apache-2.0 | https://github.com/rust-lang/regex |
| `regex-syntax` | 0.8.11 | MIT OR Apache-2.0 | https://github.com/rust-lang/regex |
| `rfd` | 0.16.0 | MIT | https://github.com/PolyMeilex/rfd |
| `rustc-hash` | 2.1.3 | Apache-2.0 OR MIT | https://github.com/rust-lang/rustc-hash |
| `rustc_version` | 0.4.1 | MIT OR Apache-2.0 | https://github.com/djc/rustc-version-rs |
| `rustversion` | 1.0.23 | MIT OR Apache-2.0 | https://github.com/dtolnay/rustversion |
| `same-file` | 1.0.6 | Unlicense/MIT | https://github.com/BurntSushi/same-file |
| `schemars` | 0.8.22 | MIT | https://github.com/GREsau/schemars |
| `schemars` | 0.9.0 | MIT | https://github.com/GREsau/schemars |
| `schemars` | 1.2.3 | MIT | https://github.com/GREsau/schemars |
| `schemars_derive` | 0.8.22 | MIT | https://github.com/GREsau/schemars |
| `scopeguard` | 1.2.0 | MIT OR Apache-2.0 | https://github.com/bluss/scopeguard |
| `selectors` | 0.38.0 | MPL-2.0 | https://github.com/servo/stylo |
| `semver` | 1.0.28 | MIT OR Apache-2.0 | https://github.com/dtolnay/semver |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde-untagged` | 0.1.9 | MIT OR Apache-2.0 | https://github.com/dtolnay/serde-untagged |
| `serde_core` | 1.0.229 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_derive` | 1.0.229 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_derive_internals` | 0.29.1 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_json` | 1.0.154 | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| `serde_repr` | 0.1.21 | MIT OR Apache-2.0 | https://github.com/dtolnay/serde-repr |
| `serde_spanned` | 1.1.2 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `serde_with` | 3.24.0 | MIT OR Apache-2.0 | https://github.com/jonasbb/serde_with/ |
| `serde_with_macros` | 3.24.0 | MIT OR Apache-2.0 | https://github.com/jonasbb/serde_with/ |
| `serialize-to-javascript` | 0.1.2 | MIT OR Apache-2.0 | https://github.com/chippers/serialize-to-javascript |
| `serialize-to-javascript-impl` | 0.1.2 | MIT OR Apache-2.0 | https://github.com/chippers/serialize-to-javascript |
| `servo_arc` | 0.4.3 | MIT OR Apache-2.0 | https://github.com/servo/stylo |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| `shlex` | 2.0.1 | MIT OR Apache-2.0 | https://github.com/comex/rust-shlex |
| `simd-adler32` | 0.3.10 | MIT | https://github.com/mcountryman/simd-adler32 |
| `siphasher` | 1.0.4 | MIT OR Apache-2.0 | https://github.com/jedisct1/rust-siphash |
| `smallvec` | 1.16.3 | MIT OR Apache-2.0 | https://github.com/servo/rust-smallvec |
| `socket2` | 0.6.5 | MIT OR Apache-2.0 | https://github.com/rust-lang/socket2 |
| `stable_deref_trait` | 1.2.1 | MIT OR Apache-2.0 | https://github.com/storyyeller/stable_deref_trait |
| `string_cache` | 0.9.0 | MIT OR Apache-2.0 | https://github.com/servo/string-cache |
| `string_cache_codegen` | 0.6.1 | MIT OR Apache-2.0 | https://github.com/servo/string-cache |
| `strsim` | 0.11.1 | MIT | https://github.com/rapidfuzz/strsim-rs |
| `strum` | 0.28.0 | MIT | https://github.com/Peternator7/strum |
| `strum_macros` | 0.28.0 | MIT | https://github.com/Peternator7/strum |
| `swift-rs` | 1.0.9 | MIT OR Apache-2.0 | https://github.com/Brendonovich/swift-rs |
| `syn` | 2.0.119 | MIT OR Apache-2.0 | https://github.com/dtolnay/syn |
| `syn` | 3.0.9 | MIT OR Apache-2.0 | https://github.com/dtolnay/syn |
| `synstructure` | 0.14.0 | MIT | https://github.com/mystor/synstructure |
| `syntect` | 5.3.0 | MIT | https://github.com/trishume/syntect |
| `tao` | 0.37.1 | Apache-2.0 | https://github.com/tauri-apps/tao |
| `tauri` | 2.12.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-build` | 2.7.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-codegen` | 2.7.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-macros` | 2.7.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-plugin` | 2.6.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-plugin-dialog` | 2.7.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-fs` | 2.5.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-runtime` | 2.12.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-runtime-wry` | 2.12.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-utils` | 2.10.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-winres` | 0.3.6 | MIT | https://github.com/tauri-apps/winres |
| `tendril` | 0.5.1 | MIT OR Apache-2.0 | https://github.com/servo/html5ever |
| `thiserror` | 2.0.21 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| `thiserror-impl` | 2.0.21 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| `time` | 0.3.55 | MIT OR Apache-2.0 | https://github.com/time-rs/time |
| `time-core` | 0.1.9 | MIT OR Apache-2.0 | https://github.com/time-rs/time |
| `time-macros` | 0.2.32 | MIT OR Apache-2.0 | https://github.com/time-rs/time |
| `tinystr` | 0.8.4 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `tinyvec` | 1.13.3 | Zlib OR Apache-2.0 OR MIT | https://github.com/Lokathor/tinyvec |
| `tokio` | 1.53.2 | MIT | https://github.com/tokio-rs/tokio |
| `toml` | 1.1.8+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `toml_datetime` | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `toml_parser` | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `toml_writer` | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `tray-icon` | 0.25.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/tray-icon |
| `typed-arena` | 2.0.2 | MIT | https://github.com/SimonSapin/rust-typed-arena |
| `typeid` | 1.0.3 | MIT OR Apache-2.0 | https://github.com/dtolnay/typeid |
| `typenum` | 1.20.1 | MIT OR Apache-2.0 | https://github.com/paholg/typenum |
| `unicode-ident` | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | https://github.com/dtolnay/unicode-ident |
| `unicode-normalization` | 0.1.25 | MIT OR Apache-2.0 | https://github.com/unicode-rs/unicode-normalization |
| `url` | 2.5.8 | MIT OR Apache-2.0 | https://github.com/servo/rust-url |
| `urlpattern` | 0.6.0 | MIT | https://github.com/denoland/rust-urlpattern |
| `utf8_iter` | 1.0.4 | Apache-2.0 OR MIT | https://github.com/hsivonen/utf8_iter |
| `utf8parse` | 0.2.2 | Apache-2.0 OR MIT | https://github.com/alacritty/vte |
| `uuid` | 1.28.0 | Apache-2.0 OR MIT | https://github.com/uuid-rs/uuid |
| `version_check` | 0.9.5 | MIT/Apache-2.0 | https://github.com/SergioBenitez/version_check |
| `walkdir` | 2.5.0 | Unlicense/MIT | https://github.com/BurntSushi/walkdir |
| `web-time` | 1.1.0 | MIT OR Apache-2.0 | https://github.com/daxpedda/web-time |
| `web_atoms` | 0.2.6 | MIT OR Apache-2.0 | https://github.com/servo/html5ever |
| `window-vibrancy` | 0.8.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri-plugin-vibrancy |
| `winnow` | 1.0.4 | MIT | https://github.com/winnow-rs/winnow |
| `writeable` | 0.6.4 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `wry` | 0.57.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/wry |
| `yoke` | 0.8.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `yoke-derive` | 0.8.4 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zerofrom` | 0.1.8 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zerofrom-derive` | 0.1.8 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zerotrie` | 0.2.5 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zerovec` | 0.11.8 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zerovec-derive` | 0.11.6 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zlib-rs` | 0.6.8 | Zlib | https://github.com/trifectatechfoundation/zlib-rs |
| `zmij` | 1.0.23 | MIT | https://github.com/dtolnay/zmij |

## 5 前端依赖（运行时，打进 `cm6.bundle.js`）

共 **25** 个第三方 npm 包。

| 包 | 版本 | 许可证 | 上游仓库 |
|---|---|---|---|
| `@codemirror/autocomplete` | 6.20.3 | MIT | https://code.haverbeke.berlin/codemirror/autocomplete |
| `@codemirror/commands` | 6.11.1 | MIT | https://code.haverbeke.berlin/codemirror/commands |
| `@codemirror/lang-css` | 6.3.1 | MIT | https://github.com/codemirror/lang-css |
| `@codemirror/lang-html` | 6.4.12 | MIT | https://code.haverbeke.berlin/codemirror/lang-html |
| `@codemirror/lang-javascript` | 6.2.5 | MIT | https://github.com/codemirror/lang-javascript |
| `@codemirror/lang-markdown` | 6.5.2 | MIT | https://code.haverbeke.berlin/codemirror/lang-markdown |
| `@codemirror/language` | 6.13.1 | MIT | https://code.haverbeke.berlin/codemirror/language |
| `@codemirror/lint` | 6.9.7 | MIT | https://code.haverbeke.berlin/codemirror/lint |
| `@codemirror/search` | 6.7.2 | MIT | https://code.haverbeke.berlin/codemirror/search |
| `@codemirror/state` | 6.7.6 | MIT | https://code.haverbeke.berlin/codemirror/state |
| `@codemirror/streamparser` | 6.0.0 | MIT | https://code.haverbeke.berlin/codemirror/streamparser |
| `@codemirror/view` | 6.43.14 | MIT | https://code.haverbeke.berlin/codemirror/view |
| `@lezer/common` | 1.5.3 | MIT | https://code.haverbeke.berlin/lezer/common |
| `@lezer/css` | 1.3.9 | MIT | https://code.haverbeke.berlin/lezer/css |
| `@lezer/highlight` | 1.2.5 | MIT | https://code.haverbeke.berlin/lezer/highlight |
| `@lezer/html` | 1.3.13 | MIT | https://github.com/lezer-parser/html |
| `@lezer/javascript` | 1.5.6 | MIT | https://code.haverbeke.berlin/lezer/javascript |
| `@lezer/lr` | 1.4.11 | MIT | https://code.haverbeke.berlin/lezer/lr |
| `@lezer/markdown` | 1.8.0 | MIT | https://code.haverbeke.berlin/lezer/markdown |
| `@marijn/find-cluster-break` | 1.0.4 | MIT | https://code.haverbeke.berlin/marijn/find-cluster-break |
| `@replit/codemirror-vim` | 6.4.0 | MIT | https://github.com/replit/codemirror-vim |
| `@replit/codemirror-vim-core` | 0.1.0 | MIT | https://github.com/replit/codemirror-vim |
| `crelt` | 1.0.7 | MIT | https://code.haverbeke.berlin/marijn/crelt |
| `style-mod` | 4.1.4 | MIT | https://code.haverbeke.berlin/marijn/style-mod |
| `w3c-keyname` | 2.2.8 | MIT | https://github.com/marijnh/w3c-keyname |

## 6 构建期工具（不分发）

| 包 | 版本 | 许可证 | 上游仓库 |
|---|---|---|---|
| `esbuild` | 0.28.2 | MIT | https://github.com/evanw/esbuild |

## 7 素材

- 应用图标 `src-tauri/icons/icon.svg` 是本仓库自绘的几何图形，无第三方素材。
- 仓库根的 `mark_feixiang.md` 是第三方产品的说明文档，仅作排版对照样本，
  **不进入公开导出树**（`scripts/export-public.sh` 里显式排除）。

