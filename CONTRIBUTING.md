# Contributing to rmd

Thanks for taking a look. rmd is a small, personal-project-turned-open-source
Markdown reader for macOS. Contributions are welcome, but the project is
deliberately narrow in scope — please read this file before opening a large PR.

## Scope

rmd is a **reader**. It opens documents, renders them, and lets you search and
navigate them. It is not a note-taking app, a knowledge base, or a Markdown
editor product: window-internal editing exists only as a controlled split view
for the document you already opened.

Feature requests that push it toward "editor / knowledge management" will
usually be declined. Bug reports, rendering fixes, performance work and
accessibility fixes are much more likely to be accepted.

## Before you start

- For anything larger than a typo or a one-line fix, **open an issue first**.
  The project has a written design process; a PR that adds a feature without an
  agreed design may be closed even if the code is good.
- rmd is free software under the **GPL-3.0-or-later** ([LICENSE](LICENSE)).
  Contributions are accepted under the same license (inbound = outbound): by
  submitting a pull request you agree to license your work that way, which is
  what lets the project stay GPL-compatible.

## Building and testing

See [BUILDING.md](BUILDING.md). The short version:

```bash
npm ci
make cm6
make build-gui
make test        # Rust tests + the Node test suite
make lint-theme  # cheap; catches hard-coded colors in CSS
```

Node.js is only needed to build the editor bundle; the shipped binary does not
depend on it.

## Code conventions

- **Native JavaScript, no frameworks, no TypeScript.** This is a deliberate
  constraint: the frontend is a set of classic `<script>` files whose load order
  matters. Each file is wrapped in an IIFE.
- **No new npm dependencies** without discussing them first. The runtime
  dependency list is pinned exactly and audited in `THIRD-PARTY-NOTICES.md`.
- **No new Rust dependencies** without discussing them first, for the same
  reason. Any new dependency (Rust or npm) must be **license-compatible with
  this project's GPL-3.0-or-later**; permissive licenses such as MIT or
  Apache-2.0 are generally fine, while copyleft licenses need a compatibility
  check before they can be accepted. The maintainer makes that call — do not
  add a new license or change the project's licensing on your own.
- Code comments and commit messages are written in **Chinese** (the project's
  working language). English-only contributions are fine, but expect the
  maintainer to translate comments.
- Tests are expected to fail before the fix and pass after it. "It works when I
  click around" is not a test result.

## Commit messages

```
type(scope): subject
```

`type` is one of `feat|fix|hotfix|perf|build|ci|chore|docs|refactor|revert|style|test`.
Keep each commit focused; separate documentation updates from behavior changes.

## Reporting bugs

Include:

- macOS version and Mac model (Apple Silicon only);
- how you started rmd (from the terminal, from the `.app`, which file);
- the document size and, if possible, a minimal reproducer — **do not paste
  private document contents**;
- the relevant lines from `~/Library/Logs/io.github.kumustone.rmd/rmd.log`
  (the log does not record document text).

Security issues: see [SECURITY.md](SECURITY.md).
