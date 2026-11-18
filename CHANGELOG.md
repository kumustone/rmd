# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project intends to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] — 2026-11-18

Reading and editing are one surface. This release makes the rendered document
the place where you work — edit it in place, restructure blocks, search,
export — and brings the surrounding application up to the same standard:
multiple windows, native tabs, a start page you can act from, and diagrams
that render where they are written.

In-place editing remains **opt-in**, as in 0.5.0: enable it with
`"live_edit": true` in `config.json`. Without the flag the reading surface is
unchanged.

### Added

- **Mermaid diagrams.** ` ```mermaid ` fences render to SVG in the reader
  (flowcharts and the other diagram types the bundled engine supports).
  Rendering happens in Rust and the result is rebuilt against an XML
  whitelist; no third-party JavaScript runs in the WebView. A diagram that
  exceeds the size budget, or whose type is not supported, falls back to a
  code block with a visible reason. Diagrams with author-defined colours keep
  them; unstyled diagrams follow the active theme.
- **Find and replace** (`⌘F`, `⌥⌘F`, next/previous with `⌘G` / `⇧⌘G`) on the
  reading surface and inside the in-place editor.
- **Export** to HTML (`⇧⌘S`) and directly to a PDF file (`⇧⌘P`). A save panel
  picks the destination and the file is written atomically; cancelling writes
  nothing and reports nothing.
- **Copy in four formats** — Markdown (`⇧⌘M`), HTML (`⇧⌘K`), plain text
  (`⌥⌘P`) and rich text (`⇧⌘R`) — and **literal paste** (`⇧⌘L`), which inserts
  the clipboard contents without interpreting them as Markdown.
- **A floating format bar for the block being edited**: headings, inline
  styles, links, quotes, lists and code; table rows and columns can be
  inserted and removed from the same place.
- **Line numbers, focus mode and canvas zoom** (`⌃⌘L`, `⌃⌘Z`, `⌃⌘=` /
  `⌃⌘-` / `⌃⌘0`).
- **Multiple windows and native window tabs.** `⇧⌘N` opens a window cascaded
  from the current one rather than stacked exactly on top, `⌘T` opens a tab,
  and *Open in New Window* is available on the start page and from the file
  tree. Dropping a file or folder on a window opens it in that window.
- **A start page you can act from.** The empty surface now begins with a
  *Start* section (`⌘L` from anywhere) offering new document, open, and the
  recent panel, each with its shortcut, followed by favourites and recent
  directories.
- **Unnamed documents.** `⌘N` creates a document immediately and asks for a
  location on the first save, instead of refusing when no folder is open.
- **Back and forward through documents** with the mouse side buttons and
  `⌘[` / `⌘]`; the history survives closing a document.
- **Favourite the current document** from *File ▸ Add to Favourites* or `⌘D`.
- **Open from the terminal wakes the running app**, including when the window
  is minimised or hidden, and the Dock/Reopen path now restores a window.

### Changed

- **One implementation draws list markers in both states.** Reading and
  editing share the browser's own `::marker` and an explicit
  `list-style-type` table (twelve marker styles cycling across nesting
  levels), replacing the hand-drawn pseudo-element family and its fitted
  constants. Ordered-list numbers align between the two states at every font
  size, including `100.` and roman numerals.
- **The two states share one typographic scale**: heading colours come from
  the reader palette, block spacing is derived from the root font size rather
  than fitted per size, empty lines inside quotes keep their height, and
  nested quotes keep their indent depth.
- **Typing no longer feels like a re-render.** The IME composition string
  keeps the caret at its right edge and committing a composition no longer
  moves it. Continuation lines inherit the list item they belong to
  (including task items), and Enter or Backspace at the start of a nested item
  outdents one level at a time.
- **Double-click in reading mode selects a word and keeps it selected** while
  the block becomes editable; triple-click selects the source line. Previously
  the click entered editing with a bare caret and nothing selected.
- **`⌘L` returns to the start page** (closing the current document without
  touching the file); font reset is back on `⌘0`.
- **Failures are reported where they happen**: a start-page action reports
  inline in its own row, structural failures use the bottom bar, and
  background maintenance only updates the neutral status line.
- **Pasting into a table cell** keeps the cell on one line while pasting, so
  the table no longer grows and shrinks around the commit.

### Fixed

- Double-clicking inside a quote or fenced code block selected nothing, so the
  text could not be copied.
- Opening a document from a terminal, or via the Dock, could leave a
  minimised or hidden window in the background.
- `⌘Z` after committing an in-place edit could revert the wrong change, or
  nothing at all.
- `Tab` inside a table cell could hang after the cell had contained `|`.
- PDF export produced an unopenable file (unbounded page count, hundreds of
  megabytes) and print output occupied only the right half of the page;
  *Export as PDF* did nothing while the in-place editor was active.
- Task-item text longer than one line wrapped entirely to the second line, and
  toggling a checkbox shifted the block by 4 px.
- Opening a favourite file while a directory was open reported that the file
  had been moved or deleted.
- List items could not be nested with `Tab`, the status bar could show
  `[object Object]`, and indentation and marker shapes differed between the
  reading and editing states.

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
[0.6.0]: #060
[0.5.0]: #050
[0.4.0]: #040
[0.3.0]: #030
