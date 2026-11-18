//! 自动化用例矩阵的 Rust 执行器（`tests/auto/cases/rust/**/*.jsonl`）。
//!
//! ⚠️ **只在 `cargo test` 下编译**（`main.rs` 里是 `#[cfg(test)] mod autotest;`），
//! 不进 release 二进制，也不改变任何产品行为。
//!
//! ## 为什么要有它
//!
//! 解析 / 渲染 / 目录 / 搜索 / 块表 / 语言 / 链接这些**纯逻辑**没有 GUI 入口，
//! 只有单元测试能触达。把用例写成 JSONL、由这里统一加载并**并行**执行，
//! 才能让"每个语法点一条用例"的规模（千条级）不需要一千个 `#[test]` 函数。
//!
//! ## 契约
//!
//! 每条用例是一行 JSON：`{"id","family","check","input","expect"}`。
//! `check` 决定用哪个检查器（见 `run_case` 的 `match`），`expect` 的语义见
//! `tests/auto/README.md`。⛔ 这里的检查器实现与 README 必须同批更新。
//!
//! ## 并行
//!
//! `matrix()` 按 CPU 数起工作线程，用例之间**不共享状态**：每个检查器自己建
//! arena / LineIndex，用完即弃。输出按用例序号排序，失败照样让 `cargo test` 退非零。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use comrak::nodes::{LineColumn, Sourcepos};
use serde_json::{json, Value};

use crate::document::blocks;
use crate::document::envelope::Envelope;
use crate::document::offset::{ColUnit, LineIndex};
use crate::document::parser::{self, ParseOpts};
use crate::document::{diagram, mermaid, render, search, toc};
use crate::link;
use crate::{config, external, lang};

struct Case {
    id: String,
    family: String,
    check: String,
    input: Value,
    expect: Value,
    file: String,
    line: usize,
}

#[test]
fn matrix() {
    let root = repo_root();
    let dir = std::env::var_os("RMD_AUTOTEST_RUST_CASES")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("tests").join("auto").join("cases").join("rust"));
    let filter = std::env::var("RMD_AUTOTEST_FILTER").unwrap_or_default();

    let mut cases = Vec::new();
    if dir.exists() {
        collect_jsonl(&dir, &mut cases);
    }
    if !filter.is_empty() {
        cases.retain(|c| c.family.contains(&filter) || c.id.contains(&filter));
    }
    if cases.is_empty() {
        // ⚠️ 带过滤串却一条都没匹配上是**合法结果**（例如只跑 exec 族时 runner 会把
        //    同一个过滤串也传给 Rust 侧）。这里必须报 0 条并正常返回，⛔ 不能 panic：
        //    panic 会让 cargo test 退 101，而 runner 侧 total/fail 都是 0，只会留下
        //    一条误导性的「框架失败」。真正的空仓库（无过滤串）仍然要炸。
        if filter.is_empty() {
            panic!(
                "自动化用例为空：{}。按 tests/auto/README.md 写用例",
                dir.display()
            );
        }
        println!("AUTOTEST rust total=0 pass=0 fail=0 ms=0");
        return;
    }

    // ⚠️ 重复 id 必须在这里就炸：报告里两条同名用例会让人以为"跑过了"。
    let mut seen = std::collections::BTreeMap::new();
    for c in &cases {
        if let Some(prev) = seen.insert(c.id.clone(), format!("{}:{}", c.file, c.line)) {
            panic!("用例 id 重复：{}（{} 与 {}）", c.id, prev, format!("{}:{}", c.file, c.line));
        }
    }

    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(cases.len());
    let next = AtomicUsize::new(0);
    let mut results: Vec<Option<Result<(), String>>> = (0..cases.len()).map(|_| None).collect();
    let started = std::time::Instant::now();

    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..workers {
            let next = &next;
            let cases = &cases;
            handles.push(scope.spawn(move || {
                let mut out = Vec::new();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= cases.len() {
                        break;
                    }
                    out.push((i, run_case(&cases[i])));
                }
                out
            }));
        }
        for handle in handles {
            for (i, result) in handle.join().expect("自动化用例工作线程 panic") {
                results[i] = Some(result);
            }
        }
    });

    let mut fail = 0usize;
    for (case, result) in cases.iter().zip(results) {
        match result.expect("工作线程没有回填结果") {
            Ok(()) => println!("CASE ok {}", case.id),
            Err(detail) => {
                fail += 1;
                println!(
                    "CASE fail {} :: {}:{} :: {}",
                    case.id,
                    case.file,
                    case.line,
                    one_line(&detail)
                );
            }
        }
    }
    println!(
        "AUTOTEST rust total={} pass={} fail={} ms={}",
        cases.len(),
        cases.len() - fail,
        fail,
        started.elapsed().as_millis()
    );
    assert_eq!(fail, 0, "{} 条 Rust 自动化用例失败", fail);
}

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/src-tauri
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri 没有上级目录")
        .to_path_buf()
}

fn collect_jsonl(dir: &Path, out: &mut Vec<Case>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("读不了用例目录 {}：{e}", dir.display()))
        .map(|e| e.expect("读目录项失败").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect_jsonl(&path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读不了用例文件 {}：{e}", path.display()));
        for (idx, raw) in text.lines().enumerate() {
            let line = idx + 1;
            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let value: Value = serde_json::from_str(trimmed).unwrap_or_else(|e| {
                panic!("{}:{line} 不是合法 JSON：{e}", path.display())
            });
            let obj = value
                .as_object()
                .unwrap_or_else(|| panic!("{}:{line} 必须是对象", path.display()));
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("{}:{line} 缺 id", path.display()))
                .to_string();
            let family = obj
                .get("family")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let check = obj
                .get("check")
                .and_then(Value::as_str)
                .unwrap_or("html")
                .to_string();
            out.push(Case {
                id,
                family,
                check,
                input: obj.get("input").cloned().unwrap_or_else(|| json!({})),
                expect: obj.get("expect").cloned().unwrap_or_else(|| json!({})),
                file: path.display().to_string(),
                line,
            });
        }
    }
}

fn run_case(case: &Case) -> Result<(), String> {
    match case.check.as_str() {
        "html" => check_html(&case.input, &case.expect),
        "toc" => check_toc(&case.input, &case.expect),
        "search" => check_search(&case.input, &case.expect),
        "blocks" => check_blocks(&case.input, &case.expect),
        "cells" => check_cells(&case.input, &case.expect),
        "tasks" => check_tasks(&case.input, &case.expect),
        "offset" => check_offset(&case.input, &case.expect),
        "lang" => check_lang(&case.input, &case.expect),
        "lang_apple" => check_lang_apple(&case.input, &case.expect),
        "link" => check_link(&case.input, &case.expect),
        "link_codec" => check_link_codec(&case.input, &case.expect),
        "envelope" => check_envelope(&case.input, &case.expect),
        "config" => check_config(&case.input, &case.expect),
        "diagram" => check_diagram(&case.input, &case.expect),
        "mermaid_class" => check_mermaid_class(&case.input, &case.expect),
        "argv" => check_argv(&case.input, &case.expect),
        other => Err(format!("未知 check `{other}`")),
    }
}

// ——————————————————————————————————————————————————————————————
// 检查器
// ——————————————————————————————————————————————————————————————

fn check_html(input: &Value, expect: &Value) -> Result<(), String> {
    let md = req_str(input, "md")?;
    let opts = opts_from(input.get("opts"));
    let html = parser::with_parsed(md, &opts, |root| render::to_html(root, &opts));
    let mut errs = Vec::new();
    if let Some(want) = expect.get("equals").and_then(Value::as_str) {
        if html != want {
            errs.push(format!("HTML 期望 {want:?}，实际 {html:?}"));
        }
    }
    for (key, want_present) in [("contains", true), ("not_contains", false)] {
        if let Some(arr) = expect.get(key).and_then(Value::as_array) {
            for item in arr {
                let Some(needle) = item.as_str() else {
                    errs.push(format!("{key} 的项必须是字符串"));
                    continue;
                };
                let present = html.contains(needle);
                if present != want_present {
                    errs.push(format!(
                        "{} {needle:?}",
                        if want_present { "缺少" } else { "不应出现" }
                    ));
                }
            }
        }
    }
    if let Some(starts) = expect.get("starts_with").and_then(Value::as_str) {
        if !html.starts_with(starts) {
            errs.push(format!("开头不是 {starts:?}"));
        }
    }
    if let Some(ends) = expect.get("ends_with").and_then(Value::as_str) {
        if !html.ends_with(ends) {
            errs.push(format!("结尾不是 {ends:?}"));
        }
    }
    if let Some(counts) = expect.get("counts").and_then(Value::as_object) {
        for (needle, want) in counts {
            let Some(want) = want.as_u64() else {
                errs.push(format!("counts[{needle:?}] 必须是整数"));
                continue;
            };
            let got = html.matches(needle.as_str()).count() as u64;
            if got != want {
                errs.push(format!("{needle:?} 出现 {got} 次，期望 {want} 次"));
            }
        }
    }
    if let Some(min) = expect.get("min_len").and_then(Value::as_u64) {
        if (html.len() as u64) < min {
            errs.push(format!("HTML 长度 {} < {min}", html.len()));
        }
    }
    if let Some(max) = expect.get("max_len").and_then(Value::as_u64) {
        if (html.len() as u64) > max {
            errs.push(format!("HTML 长度 {} > {max}", html.len()));
        }
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{}；实际 HTML 前 240 字：{:?}",
            errs.join("；"),
            truncate(&html, 240)
        ))
    }
}

fn check_toc(input: &Value, expect: &Value) -> Result<(), String> {
    let md = req_str(input, "md")?;
    let opts = opts_from(input.get("opts"));
    let entries = parser::with_parsed(md, &opts, |root| {
        let index = LineIndex::new(md);
        toc::build(root, md, &index, opts.col_unit())
    });
    let got = Value::Array(
        entries
            .iter()
            .map(|e| {
                json!({
                    "level": e.level,
                    "text": e.text,
                    "id": e.id,
                    "line": e.line,
                    "span": [e.span.start, e.span.end],
                })
            })
            .collect(),
    );
    verify(&got, expect)
}

fn check_search(input: &Value, expect: &Value) -> Result<(), String> {
    let md = req_str(input, "md")?;
    let needle = req_str(input, "needle")?;
    let index = LineIndex::new(md);
    let hits = search::find_all(md, needle, &index);
    let got = Value::Array(
        hits.iter()
            .map(|h| {
                json!({
                    "line": h.line,
                    "span": [h.span.start, h.span.end],
                    "utf16": [h.utf16_in_line.start, h.utf16_in_line.end],
                    "excerpt": h.excerpt,
                })
            })
            .collect(),
    );
    verify(&got, expect)
}

fn check_blocks(input: &Value, expect: &Value) -> Result<(), String> {
    let md = req_str(input, "md")?;
    let opts = opts_from(input.get("opts"));
    let spans = parser::with_parsed(md, &opts, blocks::build);
    let got = Value::Array(
        spans
            .iter()
            .map(|b| {
                json!({
                    "index": b.index,
                    "kind": b.kind.name(),
                    "start_line": b.start_line,
                    "end_line": b.end_line,
                    "editable": b.editable,
                })
            })
            .collect(),
    );
    verify(&got, expect)
}

fn check_cells(input: &Value, expect: &Value) -> Result<(), String> {
    let md = req_str(input, "md")?;
    let opts = opts_from(input.get("opts"));
    let index = LineIndex::new(md);
    let tables = parser::with_parsed(md, &opts, |root| blocks::table_cells(root, md));
    let got = Value::Array(
        tables
            .iter()
            .map(|(block, cells)| {
                json!({
                    "block": block,
                    "cells": cells.iter().map(|c| {
                        let text = index
                            .line_str(md, c.line as usize)
                            .map(|line| utf16_slice(line, c.from as usize, c.to as usize))
                            .unwrap_or_default();
                        json!({
                            "line": c.line, "from": c.from, "to": c.to,
                            "writable": c.writable, "text": text,
                        })
                    }).collect::<Vec<_>>(),
                })
            })
            .collect(),
    );
    verify(&got, expect)
}

fn check_tasks(input: &Value, expect: &Value) -> Result<(), String> {
    let md = req_str(input, "md")?;
    let opts = opts_from(input.get("opts"));
    let index = LineIndex::new(md);
    let items = parser::with_parsed(md, &opts, |root| blocks::task_items(root, md));
    let got = Value::Array(
        items
            .iter()
            .map(|(block, tasks)| {
                json!({
                    "block": block,
                    "items": tasks.iter().map(|t| {
                        let symbol = index
                            .line_str(md, t.line as usize)
                            .map(|line| utf16_slice(line, t.from as usize, t.to as usize))
                            .unwrap_or_default();
                        json!({
                            "line": t.line, "from": t.from, "to": t.to,
                            "checked": t.checked, "writable": t.writable, "symbol": symbol,
                        })
                    }).collect::<Vec<_>>(),
                })
            })
            .collect(),
    );
    verify(&got, expect)
}

fn check_offset(input: &Value, expect: &Value) -> Result<(), String> {
    let md = req_str(input, "md")?;
    let line = req_u64(input, "line")? as usize;
    let col = req_u64(input, "col")? as usize;
    let unit = match input.get("unit").and_then(Value::as_str).unwrap_or("bytes") {
        "bytes" => ColUnit::Bytes,
        "chars" => ColUnit::Chars,
        other => return Err(format!("unit 只能是 bytes/chars，收到 {other}")),
    };
    let which = input.get("which").and_then(Value::as_str).unwrap_or("start");
    let index = LineIndex::new(md);
    let sp = Sourcepos {
        start: LineColumn { line, column: col },
        end: LineColumn { line, column: col },
    };
    let got = match which {
        "start" => index.start_offset(md, &sp, unit),
        "end" => index.end_offset(md, &sp, unit),
        other => return Err(format!("which 只能是 start/end，收到 {other}")),
    };
    let got = match got {
        Some(n) => json!({ "offset": n }),
        None => json!({ "offset": null }),
    };
    verify(&got, expect)
}

fn check_lang(input: &Value, expect: &Value) -> Result<(), String> {
    let preference = input
        .get("preference")
        .and_then(Value::as_str)
        .ok_or("input.preference 必须是字符串")?;
    let system = parse_lang(req_str(input, "system")?)?;
    let got = json!(lang::resolve(preference, system).tag());
    verify(&got, expect)
}

fn check_lang_apple(input: &Value, expect: &Value) -> Result<(), String> {
    let text = req_str(input, "text")?;
    let got = json!(lang::parse_apple_languages(text).tag());
    verify(&got, expect)
}

fn check_link(input: &Value, expect: &Value) -> Result<(), String> {
    let href = req_str(input, "href")?;
    let got = match link::classify(href) {
        link::Classified::Empty => json!({"kind": "empty"}),
        link::Classified::Anchor { fragment } => json!({"kind": "anchor", "fragment": fragment}),
        link::Classified::External { url } => json!({"kind": "external", "url": url}),
        link::Classified::LocalFile { path, fragment } => {
            json!({"kind": "local_file", "path": path, "fragment": fragment})
        }
        link::Classified::LocalPath { path, fragment } => {
            json!({"kind": "local_path", "path": path, "fragment": fragment})
        }
        link::Classified::LocalQuery => json!({"kind": "local_query"}),
        link::Classified::Unsupported { scheme } => {
            json!({"kind": "unsupported", "scheme": scheme})
        }
    };
    verify(&got, expect)
}

fn check_link_codec(input: &Value, expect: &Value) -> Result<(), String> {
    let source = req_str(input, "s")?;
    let value = match req_str(input, "fn")? {
        "encode" => link::percent_encode(source),
        "decode" => link::percent_decode(source),
        "normalize" => link::normalize_lexically(source),
        other => return Err(format!("link_codec.fn 只能是 encode/decode/normalize，收到 {other}")),
    };
    verify(&json!({ "value": value }), expect)
}

fn check_envelope(input: &Value, expect: &Value) -> Result<(), String> {
    let raw = req_str(input, "raw")?;
    let envelope = Envelope::detect_raw(raw.as_bytes());
    let normalized = envelope
        .normalize_bytes(raw.as_bytes())
        .map_err(|e| format!("normalize_bytes 失败：{e}"))?;
    let restored = envelope.restore(&normalized);
    let got = json!({
        "bom": envelope.bom,
        "eol": match envelope.eol {
            crate::document::envelope::Eol::Lf => "lf",
            crate::document::envelope::Eol::CrLf => "crlf",
            crate::document::envelope::Eol::Other => "other",
        },
        "lossy": envelope.is_lossy(),
        "normalized": normalized,
        "restored": restored,
    });
    verify(&got, expect)
}

fn check_config(input: &Value, expect: &Value) -> Result<(), String> {
    let got = match req_str(input, "fn")? {
        "normalize_language" => {
            let pref = input.get("arg").and_then(Value::as_str);
            json!(config::normalize_language(pref))
        }
        "clamp_num" => json!(config::clamp_num(
            req_f64(input, "v")?,
            req_f64(input, "lo")?,
            req_f64(input, "hi")?,
            req_f64(input, "fallback")?,
        )),
        "clamp_content_width" => json!(config::clamp_content_width(req_f64(input, "v")?)),
        "normalize_ignore_dirs" => {
            let raw = input
                .get("raw")
                .and_then(Value::as_array)
                .ok_or("input.raw 必须是数组")?
                .iter()
                .map(|v| v.as_str().map(str::to_string).ok_or("raw 的项必须是字符串"))
                .collect::<Result<Vec<_>, _>>()?;
            json!(config::normalize_ignore_dirs(raw))
        }
        other => return Err(format!("config.fn 未知：{other}")),
    };
    verify(&json!({ "value": got }), expect)
}

fn check_diagram(input: &Value, expect: &Value) -> Result<(), String> {
    let src = req_str(input, "src")?;
    let kind = input.get("kind").and_then(Value::as_str).unwrap_or("flow");
    let result = match kind {
        "flow" => diagram::to_mermaid_flow(src),
        "sequence" => diagram::to_mermaid_sequence(src),
        other => return Err(format!("diagram.kind 只能是 flow/sequence，收到 {other}")),
    };
    let (ok, out, reject) = match result {
        Ok(out) => (true, out, String::new()),
        Err(e) => (false, String::new(), format!("{e:?}")),
    };
    let mut errs = Vec::new();
    if let Some(want) = expect.get("ok").and_then(Value::as_bool) {
        if want != ok {
            errs.push(format!("ok 期望 {want}，实际 {ok}（reject={reject}）"));
        }
    }
    for (key, want_present) in [("out_contains", true), ("out_not_contains", false)] {
        if let Some(arr) = expect.get(key).and_then(Value::as_array) {
            for item in arr {
                let Some(needle) = item.as_str() else {
                    errs.push(format!("{key} 的项必须是字符串"));
                    continue;
                };
                if out.contains(needle) != want_present {
                    errs.push(format!(
                        "{} {needle:?}",
                        if want_present { "缺少" } else { "不应出现" }
                    ));
                }
            }
        }
    }
    if let Some(prefix) = expect.get("reject_contains").and_then(Value::as_str) {
        if !reject.contains(prefix) {
            errs.push(format!("reject {reject:?} 不含 {prefix:?}"));
        }
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(format!("{}；out 前 240 字：{:?}", errs.join("；"), truncate(&out, 240)))
    }
}

fn check_mermaid_class(input: &Value, expect: &Value) -> Result<(), String> {
    let src = req_str(input, "src")?;
    let got = match mermaid::classify(src) {
        Ok(kind) => json!({"ok": true, "kind": kind}),
        Err(e) => json!({"ok": false, "reject": format!("{e:?}")}),
    };
    verify(&got, expect)
}

fn check_argv(input: &Value, expect: &Value) -> Result<(), String> {
    let path = req_str(input, "path")?;
    let configured = input.get("configured").and_then(Value::as_str);
    let argv = external::editor_argv(configured, Path::new(path));
    let got: Vec<String> = argv
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    verify(&json!({ "argv": got, "len": got.len() }), expect)
}

// ——————————————————————————————————————————————————————————————
// 期望值匹配：对象按键子集递归，数组按长度逐项
// ——————————————————————————————————————————————————————————————

fn verify(got: &Value, expect: &Value) -> Result<(), String> {
    let mut errs = Vec::new();
    if let Some(obj) = expect.as_object() {
        if let Some(want) = obj.get("count") {
            match (got.as_array(), want.as_u64()) {
                (Some(g), Some(w)) if g.len() as u64 == w => {}
                (Some(g), Some(w)) => errs.push(format!("count 期望 {w}，实际 {}", g.len())),
                _ => errs.push("count 需要数组结果与整数期望".into()),
            }
        }
        if let Some(items) = obj.get("items") {
            match (got.as_array(), items.as_array()) {
                (Some(g), Some(w)) => {
                    if w.len() > g.len() {
                        errs.push(format!("items 期望 {} 项，实际只有 {}", w.len(), g.len()));
                    }
                    for (i, wi) in w.iter().enumerate() {
                        if let Some(gi) = g.get(i) {
                            partial(gi, wi, &format!("items[{i}]"), &mut errs);
                        }
                    }
                }
                _ => errs.push("items 需要数组结果与数组期望".into()),
            }
        }
        if let Some(at) = obj.get("at").and_then(Value::as_object) {
            for (key, want) in at {
                let Ok(i) = key.parse::<usize>() else {
                    errs.push(format!("at 的键 `{key}` 不是下标"));
                    continue;
                };
                match got.as_array().and_then(|a| a.get(i)) {
                    Some(gi) => partial(gi, want, &format!("at[{i}]"), &mut errs),
                    None => errs.push(format!("at[{i}] 越界（实际 {} 项）", got.as_array().map(Vec::len).unwrap_or(0))),
                }
            }
        }
        for (key, want) in obj {
            if matches!(key.as_str(), "count" | "items" | "at") {
                continue;
            }
            match got.get(key) {
                Some(gv) => partial(gv, want, key, &mut errs),
                None => errs.push(format!("结果缺少字段 `{key}`")),
            }
        }
    } else {
        partial(got, expect, "$", &mut errs);
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(format!("{}；实际值：{}", errs.join("；"), truncate(&got.to_string(), 400)))
    }
}

fn partial(got: &Value, want: &Value, path: &str, errs: &mut Vec<String>) {
    match want {
        Value::Object(w) => match got.as_object() {
            Some(g) => {
                for (key, wv) in w {
                    match g.get(key) {
                        Some(gv) => partial(gv, wv, &format!("{path}.{key}"), errs),
                        None => errs.push(format!("{path}.{key} 缺失")),
                    }
                }
            }
            None => errs.push(format!("{path} 期望对象，实际 {got}")),
        },
        Value::Array(w) => match got.as_array() {
            Some(g) => {
                if g.len() != w.len() {
                    errs.push(format!("{path} 长度期望 {}，实际 {}", w.len(), g.len()));
                }
                for (i, (gv, wv)) in g.iter().zip(w).enumerate() {
                    partial(gv, wv, &format!("{path}[{i}]"), errs);
                }
            }
            None => errs.push(format!("{path} 期望数组，实际 {got}")),
        },
        _ => {
            if got != want {
                errs.push(format!("{path} 期望 {want}，实际 {got}"));
            }
        }
    }
}

// ——————————————————————————————————————————————————————————————
// 小工具
// ——————————————————————————————————————————————————————————————

fn opts_from(value: Option<&Value>) -> ParseOpts {
    let mut opts = ParseOpts::default();
    let Some(map) = value.and_then(Value::as_object) else {
        return opts;
    };
    for (key, slot) in [
        ("render_sourcepos", &mut opts.render_sourcepos),
        ("sourcepos_chars", &mut opts.sourcepos_chars),
        ("heading_ids", &mut opts.heading_ids),
        ("math_dollars", &mut opts.math_dollars),
        ("hardbreaks", &mut opts.hardbreaks),
    ] {
        if let Some(v) = map.get(key).and_then(Value::as_bool) {
            *slot = v;
        }
    }
    opts
}

fn parse_lang(tag: &str) -> Result<lang::Lang, String> {
    match tag {
        "zh" => Ok(lang::Lang::Zh),
        "en" => Ok(lang::Lang::En),
        other => Err(format!("system 只能是 zh/en，收到 {other}")),
    }
}

fn req_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("input.{key} 必须是字符串"))
}

fn req_u64(input: &Value, key: &str) -> Result<u64, String> {
    input
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("input.{key} 必须是非负整数"))
}

fn req_f64(input: &Value, key: &str) -> Result<f64, String> {
    input
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("input.{key} 必须是数字"))
}

fn utf16_slice(line: &str, from: usize, to: usize) -> String {
    let mut out = String::new();
    let mut unit = 0usize;
    for ch in line.chars() {
        let width = ch.len_utf16();
        if unit >= from && unit + width <= to {
            out.push(ch);
        }
        unit += width;
        if unit >= to {
            break;
        }
    }
    out
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let cut: String = text.chars().take(limit).collect();
    format!("{cut}…")
}

fn one_line(text: &str) -> String {
    text.replace('\n', "\\n").replace('\r', "\\r")
}
