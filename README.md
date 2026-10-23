# rmd — makes technical documents comfortable to read

A Markdown reader for macOS. Opens local Markdown documents from the terminal or another app, typeset with care, easy to find your files.

[中文说明](README.zh-CN.md)

> **Status: released.** The first public version [`0.4.0`](https://github.com/kumustone/rmd/releases/tag/v0.4.0) is out, with a
> macOS (Apple Silicon) build attached. The source is licensed under
> **GPL-3.0-or-later** (see *License*). See *Install* to download it, or
> [BUILDING.md](BUILDING.md) to build from source.

[![rmd reading a Markdown document — sidebar, toolbar and typeset body](assets/screenshots/theme-light.png)](assets/screenshots/theme-light.png)

## Why rmd

Reading technical documents shouldn't require opening a coding tool first. Whether you're
jumping into a document from Claude or hunting through a local folder, rmd wants to get you
reading sooner — and keep it comfortable:

- **Open it from anywhere** — open a local Markdown document from the terminal or from another app.
- **Typography you actually want to look at** — spacing tuned for reading Chinese, with light, dark and warm themes (or follow the system).
- **Find your material fast** — folder browsing and filename search make documents scattered across folders easy to locate.
- **Long documents stay navigable** — locate content with the outline and in-document search, and pick up where you left off next time.

rmd started from a simple wish: a handy, good-looking way to open the technical
documents I read every day.

## What it is

A reader first, with editing you have to ask for. Open a Markdown file or a folder and read:

- **Rendering happens in Rust** — parsing, syntax highlighting, math and diagrams are
  finished before the HTML reaches the window. Measured costs for files up to 10 MB are in
  [assets/performance/](assets/performance/).
- **Editing is explicit** — a split view (source on the left, rendered output on the right)
  using CodeMirror 6, with optional Vim keybindings. The reader never writes to a file you
  did not open for editing.
- **Hand-off, not lock-in** — open the current document in your own editor and rmd reloads
  it when the file changes on disk.
- **Chinese / English interface** — menus, status bar and messages follow one language
  setting; document content is never translated.

What it is not: a note-taking app, knowledge base or synced notebook; a Markdown editor
product (editing exists only for the document you explicitly opened); or cross-platform —
**macOS 13+, Apple Silicon only.**

## Themes

Light, dark and warm. The three screenshots below are the same document — a
self-written sample page showing Chinese typography, inline code, a highlighted
Rust block, inline plus display math, a table and a note — captured at the same
reading settings (16 px, line height 1.75, content width 860). Click any one of
them to see it full size. Switching the theme changes colors only; font size,
line height and width stay where you put them.

| Light | Dark | Warm |
| :---: | :---: | :---: |
| [![Light theme](assets/screenshots/theme-light.png)](assets/screenshots/theme-light.png) | [![Dark theme](assets/screenshots/theme-dark.png)](assets/screenshots/theme-dark.png) | [![Warm theme](assets/screenshots/theme-warm.png)](assets/screenshots/theme-warm.png) |

## Install

### Download

Download `rmd-0.4.0-arm64.dmg` (6 MB; a `.sha256` is attached alongside) from
[Releases](https://github.com/kumustone/rmd/releases/latest) and drag `rmd.app` into `/Applications`.

The build is **ad-hoc signed** (not notarized), so Gatekeeper blocks the first launch:
right-click (or Control-click) → **Open** → **Open** again — or use
**System Settings ▸ Privacy & Security → Open Anyway**. macOS remembers the choice after
that.

**macOS 13+, Apple Silicon only.**

### Build and run from source

Running the bare binary needs no installation step and no `.app`:

```bash
npm ci                        # frontend toolchain (Node is needed to build, never to run)
make cm6                      # bundle CodeMirror 6 into src/vendor/cm6.bundle.js
make build-gui NO_INSTALL=1   # without NO_INSTALL, build-gui also copies the binary to ~/.local/bin
./src-tauri/target/release/rmd /path/to/document.md
```

When stdout and stderr are both a terminal, the binary re-launches itself in the background
and your prompt comes back immediately. `RMD_FOREGROUND=1` keeps it in the foreground with
logs on stderr. Exit code 0 only means the child process was created.

### Assemble and install the app

```bash
make install-app NO_INSTALL=1   # build the GUI binary, assemble build/macos/rmd.app, copy it to ~/Applications
```

`make install-app` already depends on the build and assembly steps, so there is nothing to
run first. `make install-app` does **not** change your default Markdown handler. To assemble
the bundle without installing it, run `make app NO_INSTALL=1` instead; the result is
`build/macos/rmd.app`.

`NO_INSTALL=1` matters: without it, `build-gui` (which both targets depend on) also drops a
**plain copy** of the binary at `~/.local/bin/rmd`. That copy is not the link the app's
*Install Command Line Tool…* menu creates — it does not follow `.app` upgrades, and it sits
where the menu wants to put its link. If `ls -l ~/.local/bin/rmd` shows a regular file left
by an earlier build and you no longer need it, move it aside or delete it; rmd itself never
removes a file it did not create.

### Use `rmd` from the terminal

Open rmd → the **rmd** menu → **Install Command Line Tool…**. It asks where to create the
link:

- `~/.local/bin` — no password needed, but it is not on `PATH` by default on macOS.
- `/usr/local/bin` — usually already on `PATH`; writing there requires an administrator password.

The link points at the binary inside the running `.app`, so replacing the app at the same
path keeps it working; moving the app elsewhere means redoing it. Afterwards the app probes
your shell once and tells you whether the terminal can reach the command yet (printing the
exact `export` line if it cannot). It does **not** modify your shell configuration.
Uninstalling is in the same menu.

<details>
<summary>Manual fallback (a symlink you create yourself)</summary>

```bash
mkdir -p ~/.local/bin
ln -sf ~/Applications/rmd.app/Contents/MacOS/rmd ~/.local/bin/rmd
```

Use the path where the app actually lives — if you dragged `rmd.app` from the DMG into
`/Applications`, that is `/Applications/rmd.app`; `make install-app` uses
`~/Applications/rmd.app`. Two prerequisites: the directory must
exist (hence `mkdir -p`), and it must be on your `PATH`. A link to a fixed path survives an
app upgrade in place; only move the app and you have to create it again.
</details>

## Keyboard

| Action | Shortcut |
|---|---|
| Open folder | `⌘O` |
| Open file | `⇧⌘O` |
| Quick open (file name search) | `⌘P` |
| Refresh file index | `⌘R` |
| Find in document | `⌘F` |
| Show/hide sidebar | `⌘B` |
| Show/hide top bar | `⇧⌘B` |
| Settings | `⌘,` |
| Open in external editor | `⇧⌘E` |
| Toggle split-view editing | `⌘E` |

The complete table is in Settings, generated from the same source as the menu; rebinding is
not supported yet.

## Performance

rmd publishes its **own** reproducible baseline only — no competitor rankings. The
measurement method, machine, corpus and the numbers themselves are in
[assets/performance/](assets/performance/). Every number there comes from a JSON result file
produced by `make bench` and can be reproduced locally.

Two things that page does **not** claim, and neither does this README: how long the GUI takes
to show its first screen, and how rmd compares to any other reader. Neither has been measured.

## Security

rmd is a local reader: no network features, no telemetry, no accounts. Raw HTML
in documents is not rendered; document content cannot navigate the reader's
window; file access is scoped to what you explicitly opened. Details and the
reporting channel are in [SECURITY.md](SECURITY.md).

## Tech stack

**Rust** (parsing, rendering, file access) inside a **Tauri 2** shell that uses the system's
WKWebView — no bundled browser engine. The UI is plain JavaScript and the DOM; CodeMirror 6
is bundled at build time for the split-view editor. **Node is needed to build rmd, never to
run it.**

Build details and prerequisites are in [BUILDING.md](BUILDING.md).

## License

rmd is free software under the **GNU General Public License, version 3 or later** — see
[LICENSE](LICENSE). Redistribution is allowed under the GPL: pass along the license and make
the corresponding source available.

Bundled third-party components and their licenses are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), generated by `make third-party`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please open an issue before starting
anything larger than a small fix.

---

*Why "rmd"? It reads Markdown. The name is short enough to type.*
