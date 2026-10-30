# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project intends to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] — 2026-10-29

Reading is the purpose; editing continues it. This release brings editing into
the reading surface itself: click a block of the rendered document and edit it
where it stands.

### Added

- **In-place editing (opt-in).** Clicking a block puts a single-block editor in
  its place — the rest of the document stays rendered, and leaving the block
  returns it to the rendered surface. Headings, paragraphs, lists, quotes, code
  blocks, table cells and task items are editable; `⌘↵` starts a new paragraph
  after the block instead of leaving editing. The previous split view (`⌘E`)
  remains available. **Off by default**: enable it with `"live_edit": true` in
  `config.json` (there is no switch in the settings overlay yet). With the flag
  unset, the reading surface is byte-for-byte what 0.4.0 showed.
- **Table cells edit in place.** Click a cell to edit only that cell; `|` is
  escaped and a line break inside a cell is stored as `<br>`. Row and column
  operations are deliberately not implemented.
- **Task-item checkboxes are clickable in the reading view.** Clicking a
  `- [ ]` box flips the one character in the source and saves it.
- **Start page with favourites and recent directories**: the empty reading
  surface lists favourite folders and recently opened directories, with
  add/remove for favourites and remove/clear for recents (two-step confirm).
- **Flat document list and file-name search in the sidebar**: a toggle inside
  the *Files* tab switches the tree to a flat list of every Markdown document,
  and a persistent search box at the bottom of the sidebar filters by file name.
  Folders with no Markdown anywhere below them are hidden from the tree.
- **Root row in the file tree, and *Reveal in Finder*** for both files and
  folders.
- **Configurable ignore list** (`ignore_dirs` in `config.json`), shared by the
  tree, the document list, filename search and the document index.
- **Disk changes are picked up consistently**: the tree and document list
  reconcile with files added or removed outside rmd, and a degraded directory
  watch is shown as a visible notice with a retry action.

### Changed

- **Documentation is split by reader.** `README` now covers installing and using
  rmd only — it no longer pins a version number, a file name or a size, and it
  repeats no build commands. Building from source, assembling the `.app`,
  packaging a DMG and what each `make` target actually produces moved to
  `BUILDING.md`, which is now the single place those commands are written.
- Opening a very large directory no longer blocks the window, and results from a
  stale keystroke are discarded instead of being merged into the view.

### Fixed

- `⌘A` selected the sidebar and the top bar along with the document in the
  reading view, and only a single block while editing one. It now selects the
  document body and nothing else.
- Files created outside rmd sometimes never appeared after a refresh: the tree
  could rebuild from a cached layer that no longer matched the disk.

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
[0.5.0]: #050
[0.4.0]: #040
[0.3.0]: #030
