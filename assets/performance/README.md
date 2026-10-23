# Performance baseline

This page publishes **rmd's own** reproducible numbers for the current release
line (`0.4.0`). There is deliberately **no comparison with other readers** — the
numbers answer "what do *these* files cost *here*", nothing more.

Every figure below comes from a JSON file produced by `make bench`. If you run
the same commands on the same class of machine you should get the same order of
magnitude. See [Reproducing](#reproducing).

---

## 1. What is measured

`rmd bench` drives the **Rust side only** — no window, no WebView. It reports six
stages per document:

| Stage | Meaning |
|---|---|
| `T1` | read the file from disk + UTF-8 validation |
| `T2` | build the arena and parse with comrak |
| `T3` | render AST → HTML (including code highlighting, math and diagrams) |
| `T7` | outline data, **Rust half only** — "outline is usable" also needs front-end work |
| `T8` | naive substring search over the rendered text, **Rust half only** |
| `t_index` | line-start offset index (an internal helper, listed so it is not hidden) |

These are stages of **one pipeline**, not a single "time to open the document".
⚠️ They **cannot be added to any GUI-side timing** measured elsewhere: the GUI
timing includes the WebView, IPC and layout, which are not present in this
process at all.

⚠️ The CLI baseline renders **with `data-sourcepos` on** (the default, kept so
today's numbers stay comparable with earlier ones). The **product (GUI) path
renders without it**, so real HTML output in the app is *smaller* than the
`HTML` column here. Do not read the two as the same figure.

---

## 2. Environment

| | |
|---|---|
| Machine | `Mac14,9` — Apple M2 Pro, 10 cores, 16 GB RAM |
| OS | macOS 27.0 (`26A428`), aarch64 |
| Build | `cargo build --release`, `profile = release`, rmd `0.4.0` |
| Parser | comrak `0.56.0` |
| Toolchain | rustc `1.98.1` (2026-09-01) |
| Run date | 2026-10-21 |

The documented minimum system is **macOS 13.0**; it has not been measured on a
13.x machine — numbers here are from macOS 27.0 on Apple Silicon only. Treat
them as "same machine class" figures, not a promise for every Mac.

---

## 3. Corpus

All samples are **generated**, never hand-picked:

```bash
python3 benchmarks/gen_corpus.py      # 17 files, ~53 MB
```

- Fixed seed `20261013`; each file's RNG is derived from `(seed, size, feature)`,
  so regenerating one file does not perturb the others.
- 4 sizes (S ≈ 100 KB, M ≈ 1 MB, L ≈ 5 MB, XL ≈ 10 MB) × 4 structures
  (`plain`, `headings`, `code`, `tables`), plus `mixed.md` at 1 MB = **17 files**.

⚠️ This is a **controlled sample**, not a survey of real documents. It is
deliberately adversarial (dense tables, thousands of headings, one very large
code file); real prose usually lands well below the `tables` and `code` rows.

---

## 4. Method

```bash
./src-tauri/target/release/rmd bench benchmarks/corpus/*.md --repeat 5 --json <out>.json
```

- **1 warm-up round** (discarded) + **5 measured rounds** per file.
- Reported statistic: **median** of the 5 rounds (not the best round).
- Files are run in one process, sequentially; nothing else heavy runs on the
  machine at the same time.

The raw result file for this page is
`benchmarks/results/2026-10-21-Mac14,9.json` — schema `rmd-bench/1`, field names
matching the stage table above. That file is a **dev-repo history record** and is
not shipped in this tree; running `make bench` produces your own copy with the
same schema.

---

## 5. Results

All times in **milliseconds, median of 5**. `Source` / `HTML` in MB.

| File | Source | HTML | HTML× | AST nodes | T1 | T2 | T3 | T7 | T8 | t_index |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `S-plain.md` | 0.10 | 0.1 | 1.07× | 375 | 0.10 | 0.10 | 0.0 | 0.002 | 0.09 | 0.03 |
| `S-headings.md` | 0.10 | 0.2 | 1.83× | 1 333 | 0.10 | 0.22 | 0.3 | 0.141 | 0.07 | 0.04 |
| `S-code.md` | 0.10 | 0.4 | 3.90× | 484 | 0.10 | 0.15 | 28.7 | 0.004 | 0.08 | 0.04 |
| `S-tables.md` | 0.10 | 0.3 | 3.04× | 8 562 | 0.10 | 1.00 | 0.6 | 0.029 | 0.07 | 0.04 |
| `M-plain.md` | 1.05 | 1.1 | 1.07× | 3 849 | 0.84 | 1.08 | 0.3 | 0.010 | 0.93 | 0.36 |
| `M-headings.md` | 1.05 | 1.9 | 1.85× | 13 513 | 0.92 | 2.28 | 2.8 | 1.481 | 0.80 | 0.42 |
| `M-code.md` | 1.05 | 4.5 | 4.25× | 5 019 | 0.70 | 1.51 | 314.1 | 0.020 | 0.71 | 0.40 |
| `M-tables.md` | 1.05 | 3.3 | 3.12× | 87 568 | 0.99 | 10.74 | 6.5 | 0.317 | 0.79 | 0.42 |
| `L-plain.md` | 5.24 | 5.6 | 1.07× | 19 077 | 4.21 | 5.42 | 2.0 | 0.051 | 4.93 | 1.79 |
| `L-headings.md` | 5.24 | 9.7 | 1.86× | 66 947 | 4.48 | 11.14 | 14.8 | 8.060 | 4.26 | 2.00 |
| `L-code.md` | 5.24 | 10.0 | 1.91× | 25 449 | 3.44 | 7.89 | 383.9 | 0.074 | 3.66 | 2.07 |
| `L-tables.md` | 5.24 | 16.5 | 3.14× | 428 560 | 4.88 | 52.84 | 32.4 | 1.547 | 3.93 | 2.05 |
| `XL-plain.md` | 10.49 | 11.3 | 1.07× | 38 321 | 8.76 | 11.04 | 3.8 | 0.106 | 9.70 | 3.59 |
| `XL-headings.md` | 10.49 | 19.5 | 1.86× | 133 553 | 9.39 | 22.81 | 30.4 | 16.755 | 8.42 | 4.02 |
| `XL-code.md` | 10.49 | 16.3 | 1.55× | 50 623 | 7.06 | 15.15 | 402.4 | 0.134 | 7.38 | 4.05 |
| `XL-tables.md` | 10.49 | 33.3 | 3.17× | 860 837 | 9.57 | 109.15 | 65.7 | 3.080 | 7.81 | 4.13 |
| `mixed.md` | 1.05 | 1.9 | 1.84× | 49 622 | 0.77 | 6.12 | 3.0 | 0.257 | 0.42 | 0.44 |

Peak process memory for the whole run (all 17 files in one process):
**360 MiB** (`resident_size_max`, sampled every 2 ms).

### What the table says

- **Reading from disk is never the problem** — `T1` stays under 10 ms even at
  10 MB.
- **Parsing is linear and cheap** (`T2`), except for table-heavy input, where the
  AST explodes (`XL-tables`: 860 837 nodes → 109 ms). Node count, not file size,
  drives `T2`.
- **`T3` is where the spread lives.** Plain prose at 10 MB renders in **3.8 ms**;
  a code-heavy document of the same size takes **402 ms**, ~100× more.
- The `code` rows show a **deliberate cap**, not a straight-line cost:
  `XL-code` highlights **2 973** code blocks and leaves **22 337** as escaped
  plain text once per-block / cumulative budgets are exhausted. An earlier build
  of rmd measured **~3.35 s** on this same corpus file *without* the cap, so
  read 402 ms as **capped**, not as "highlighting everything got cheap". The app
  is honest about it — the status bar reports how many blocks were not
  syntax-highlighted.
- **`T7`/`T8` are Rust halves only.** `XL-headings` carries 31 425 outline
  entries, and the real "outline feels instant" claim needs the front end too —
  not measured here.

⚠️ **Do not add the columns up and call it "open time".** The app's open path
also includes IPC, WebView parsing of the HTML, first layout and paint. None of
that is in this table.

---

## 6. Not measured (and why)

| Item | Why not | Status |
|---|---|---|
| GUI cold start (process → window visible) | requires launching the real app and taking focus | **not measured** for 0.4.0 |
| First screen (parse → first paint in the WebView) | same | **not measured** for 0.4.0 |
| Large-directory scan / tree build | opens a window | **not measured** for 0.4.0 |
| WebView memory | lives in another process | **not measured** |
| Real-world documents | would not be reproducible | by design |

Older GUI-side measurements exist in the development history but were taken on a
different version with a different pipeline; they are **not** republished here as
0.4.0 numbers. Anything not in the table above should be treated as unknown, not
as "fast enough".

---

## 7. Reproducing

```bash
make corpus          # regenerate benchmarks/corpus/ (17 files, ~53 MB)
make build           # release CLI build
make bench           # 17 files × 5 rounds (+1 warm-up) → benchmarks/results/<date>-<model>.json
```

Notes:

- `make bench` **refuses to overwrite** an existing result file. Rename the old
  one first; the results directory is kept as history on purpose.
- `make bench-quick` runs 3 XL files without writing anything — useful as a
  smoke check after a code change.
- Don't run `make bench` while something else is compiling or installing; CPU
  contention moves every number.
- Numbers scale with the chip and with thermal state. Compare only runs from the
  same machine class, and always quote the median and the round count.
