# Building rmd from source

rmd is a local Markdown reader for macOS (Apple Silicon). This file covers
building and running it from a clean checkout.

> **Status:** [`0.4.0`](https://github.com/kumustone/rmd/releases/tag/v0.4.0) is the first public release. This file is for
> building from source — to install the prebuilt app instead, see the README.
> See *License* at the end of this file.

## Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| macOS | 13.0+ (arm64) | Only Apple Silicon is supported. Built and tested on macOS 27.0. |
| Xcode Command Line Tools | current | `xcode-select --install` |
| Rust | 1.89+ (tested with 1.98.1) | `rustup` recommended |
| Node.js | 20+ (tested with v26.8.2) | **Build-time only.** See below. |
| npm | ships with Node | |

Node.js is needed for exactly one step: bundling the CodeMirror 6 editor into
`src/vendor/cm6.bundle.js`. The bundle is embedded into the binary at compile
time, so the installed application does **not** need Node.js.

## Build

```bash
git clone <repository-url> rmd
cd rmd

npm ci                    # install the exact frontend toolchain from package-lock.json
make cm6                  # bundle CodeMirror 6 -> src/vendor/cm6.bundle.js
make build-gui NO_INSTALL=1   # release build with the GUI (this is the real binary)
```

`make build-gui` links the whole Tauri dependency tree and takes a few minutes
on a first run. It produces `src-tauri/target/release/rmd`.

`NO_INSTALL=1` keeps the build from also copying the binary to `~/.local/bin/rmd`.
Drop it only if you want that plain copy; note that the copy is not the link the
app's *Install Command Line Tool…* menu creates (it does not follow `.app`
upgrades, and it occupies the path the menu wants).

> `make build` builds a CLI-only binary (probe/benchmark subcommands). It is
> faster but **cannot open a window**; if you run it with a file argument it
> will say so instead of failing silently. Use `make build-gui` for anything
> user-facing.

## Run

```bash
make open                        # opens a bundled 10 MB Chinese sample document
make open FILE=/path/to/doc.md   # opens your own file
```

Or start the binary directly:

```bash
./src-tauri/target/release/rmd /path/to/doc.md
./src-tauri/target/release/rmd /path/to/a/directory
```

When both stdout and stderr are a terminal, the binary re-launches itself in
the background and the parent exits immediately, so your shell prompt comes
back. Exit code 0 only means the child process was created — not that a window
is open. To keep it in the foreground (with logs on stderr):

```bash
RMD_FOREGROUND=1 ./src-tauri/target/release/rmd /path/to/doc.md
```

Logs are written to `~/Library/Logs/io.github.kumustone.rmd/rmd.log`.

## Assemble a `.app` bundle

The repository does not use `tauri-cli`; the bundle is assembled by a script:

```bash
make install-app NO_INSTALL=1   # build, assemble, then copy to ~/Applications and refresh LaunchServices
```

`make install-app` depends on the build and on `make app`, so one command is
enough. To assemble the bundle without installing it:

```bash
make app NO_INSTALL=1           # -> build/macos/rmd.app
```

Without `NO_INSTALL=1`, the `build-gui` step behind both targets also leaves a
plain copy at `~/.local/bin/rmd`. If `ls -l ~/.local/bin/rmd` shows such a file
from an earlier build and you do not need it, move or delete it before using the
app's *Install Command Line Tool…* menu — that menu creates a link and leaves
files it did not create untouched.

The bundle is ad-hoc signed (no Developer ID, no notarization). On first launch,
macOS Gatekeeper may require *System Settings → Privacy & Security → Open Anyway*.
`make install-app` does **not** change your default Markdown handler.

## Tests

```bash
make test            # Rust unit + integration tests, then the Node test suite
make test-js         # frontend logic tests only (fast)
make lint-theme      # theme invariants (literal colors, required variables)
make doctor          # environment / toolchain / corpus self-check
```

GUI behaviour that needs a real window is exercised by a separate set of
offscreen probes (e.g. `make probe-scroll-sync`); they never take focus.

## Third-party components

The list of bundled third-party code and its licenses is generated, not
hand-written:

```bash
make third-party        # regenerate THIRD-PARTY-NOTICES.md
make check-third-party  # verify it is up to date
```

⚠️ The list also shows the Mermaid renderer (`flowmaid`): GPL-3.0-or-later,
the same license as rmd, so shipping it is a normal GPL obligation rather than
a conflict. See `THIRD-PARTY-NOTICES.md` §2.

## License

rmd is free software under the **GNU General Public License, version 3 or
later** — see [LICENSE](LICENSE). Redistribution is allowed under the GPL
(ship the license and make the corresponding source available).
