# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project intends to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Documentation is split by reader.** `README` now covers installing and using
  rmd only — it no longer pins a version number, a file name or a size, and it
  repeats no build commands. Building from source, assembling the `.app`,
  packaging a DMG and what each `make` target actually produces moved to
  `BUILDING.md`, which is now the single place those commands are written.

## [0.4.0] — 2026-10-23

First public release. Source and a macOS (arm64) build are attached to the
`v0.4.0` release on GitHub.

### Added

- **Bilingual interface (Chinese / English).** Language is chosen once, in the
  backend, from the system preference and a saved override; menus, the status
  bar and all UI messages follow it. Document content is never translated.
- **Safe link navigation inside documents.** Relative links to other Markdown
  documents open in the reader (with the same permission checks as opening a
  file from the sidebar); anchors jump within the current document; external
  links are handed to the default browser. The reader's own WebView can no
  longer be navigated away by document content.
- **Build, license and contribution documents**: `BUILDING.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, and a generated
  `THIRD-PARTY-NOTICES.md` (`make third-party`).
- **File-tree actions**: right-click a folder to create a new Markdown file,
  right-click a file to rename it or copy its absolute path; `⌘R` rebuilds the
  file index after changes made outside rmd.
- **Install the `rmd` command from the app**: *rmd ▸ Install Command Line
  Tool…* creates a link to the running `.app` in `~/.local/bin` or
  `/usr/local/bin`, and can remove it again from the same menu.
- **Collapsible top bar**: `⇧⌘B` (or the chevron in the toolbar) hides the
  toolbar and status row for distraction-free reading; a thin grab handle
  brings them back.
- **Images next to a single-file document** are now shown, using the same
  authorization check as any other local asset.
- **GPL-3.0-or-later**: the source now carries a `LICENSE` file (GNU GPL v3),
  and `Cargo.toml` / `package.json` declare `GPL-3.0-or-later`. The Mermaid
  renderer (`flowmaid`) is GPL-3.0-or-later too, so the whole program is now
  consistent and redistributable under the GPL.

### Changed

- The declared minimum macOS version is now **13.0** (was 12.0), based on the
  WebKit features the interface actually uses. Only Apple Silicon is supported.
- The scrollbar thumb now has an opaque fallback on WebKit versions that do not
  support `color-mix()`.

### Fixed

- Clicking a link in a document could reload or navigate the whole reader
  window; `http(s)` links could take the window away permanently.

## [0.3.0]

The last pre-public working version. It contains the reader itself: fast
opening of large files, Chinese typography, file tree, filename search,
in-document find, outline, themes (system / light / dark / warm), reading
progress, image zoom preview, external-editor hand-off with file watching,
split-view editing with CodeMirror 6 (optionally with Vim keybindings),
directory session restore, menu/shortcut settings, logging, and a `.app`
assembly path with ad-hoc signing.

[Unreleased]: #unreleased
[0.4.0]: #040
[0.3.0]: #030
