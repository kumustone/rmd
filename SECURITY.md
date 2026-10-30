# Security policy

rmd is a local Markdown reader. It has no network features, no telemetry and no
accounts. **In reading mode it never writes to your documents**: the only files
it writes on its own are its own config and log.

Everything else that touches disk is **explicitly triggered by you** and limited
to the action you asked for:

- **Creating a file** writes one new empty Markdown file inside the folder you
  already opened, and refuses names that rmd itself ignores (hidden entries,
  `node_modules`, the configured ignore list).
- **Renaming** renames exactly one entry, only inside an authorized folder, and
  only for a regular `.md` file; the current document is never renamed while it
  is open for editing.
- **Saving an edit** writes back **exactly one file: the document you opened for
  editing** — text only, through a temporary file plus atomic rename.
- **Installing / uninstalling the command-line tool** is a menu action that
  creates or removes one symlink (`~/.local/bin/rmd` or `/usr/local/bin/rmd`).
  It never deletes or overwrites entries rmd did not create; writing to
  `/usr/local/bin` requires the administrator authorization macOS shows you.

## Supported versions

There is no published release yet (first public release targeted at `0.4.0`).
Until then, security fixes land on `main` only; there are no maintained older
branches.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's **private vulnerability reporting** on this repository
(*Security* tab → *Report a vulnerability*). The repository is not public yet;
once it is, that is the only supported channel. No email address is published.

Please include:

- affected version or commit;
- the smallest document/file setup that reproduces the issue;
- what you expected vs. what happened, and the impact you believe it has.

⚠️ **Do not paste private document contents or credentials.** A minimal
synthetic Markdown file is always enough — if it isn't, say so and describe the
shape of the input instead.

## Threat model (what rmd does and does not do)

These are the properties the code is designed and tested around:

- **Markdown raw HTML is never passed through.** The renderer's unsafe flag is
  never enabled (`src-tauri/src/document/parser.rs`, `INV-SEC-01`). Document
  contents cannot inject script or markup into the reader.
- **The reader's WebView is never navigated by document content.** Every link
  is intercepted; external `http(s)`/`mailto` links are handed to the default
  browser only after an explicit click, and the reader window stays on its own
  page (`INV-LINK-02`).
- **File access is authorization-scoped.** Opening a document or directory
  grants access to that path only. Local images are read through the same
  authorization check and inlined as `data:` URLs; the app does not accept
  arbitrary `file://` references from a document.
- **Editing can only write the one document you opened for editing.** The save
  command takes document *text*, not a path, so it cannot name a target: it
  writes the session's current document only, through the same authorization
  check as reading, as a temporary file plus atomic rename. Editing mode is
  entered explicitly (split view, `⌘E`); the reader never rewrites a file in the
  background, and nothing else on disk is touched.
- **No shell interpolation.** External editors/links are spawned with an argv
  array, never through a shell.
- **Logs do not contain document text.** The log records lengths, counts, paths
  and error classes only.

Known hardening gaps (tracked, not secrets — please still report if you find a
way to exploit them):

- The WebView is currently created with **no Content-Security-Policy**
  (`csp: null` in the Tauri config). With raw HTML disabled the injection
  surface is small, but a CSP is the right defense in depth and is planned.
- The `.app` is **ad-hoc signed**; there is no notarization yet, so macOS cannot
  attest the download's origin.

## Scope

Out of scope: issues that require an already-compromised machine, attacks that
only affect the local user's own documents by design (e.g. a huge document
making the app slow), and reports produced solely by a scanner without a
demonstrated impact.
