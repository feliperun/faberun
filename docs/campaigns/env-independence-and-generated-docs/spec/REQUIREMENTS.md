---
id: env-independence-and-generated-docs
title: "Tests that assume nothing about the machine, and a manual the code writes"
version: 1.0.0
status: accepted
date: 2026-09-17
owner: Felipe Broering
target: feliperun/faberun
baseline: 6a9fec1
derived_from: PROPOSAL.md (pt-BR) and ADDENDUM.md; requirements derived from their phases and definitions of done
---

# Tests that assume nothing about the machine, and a manual the code writes

## Intent

Two defect classes stay open, and both are closable structurally rather than
case by case: tests that encode the author's machine (where a binary lives,
which version manager, which platform), and hand-written documentation of
code surface that a codebase already declares. The goal is not to fix the two
known cases; it is to make both classes inexpressible.

## Requirements

### R1. The installer test builds its own PATH instead of asserting a layout

- **statement:** the install.sh test constructs the PATH it needs from
  symlinks to the binaries the installer legitimately calls, rather than
  re-adding `/bin` and `/usr/bin` and assuming node lives outside both.
- **proof:** `command: node --test --test-name-pattern="install.sh fails when node is missing from PATH" test/host/install-sh.test.mjs`

### R2. A host-layout guard closes the class

- **statement:** a guard scans test files and rejects an absolute
  system-binary path used to build PATH outside a declared write, a
  version-manager reference in an assertion, an assertion on binary absence
  without a constructed PATH, and `process.platform` in a
  non-platform-specific assertion; an exemption is a same-line marker with a
  reason.
- **proof:** `command: node --test --test-name-pattern="no test file assumes a host-specific PATH, version manager, platform branch, or fixture shebang" test/host/host-layout.test.mjs`

### R3. The four root pointers stay symlinks

- **statement:** `AGENT.md`, `CLAUDE.md`, `CURSOR.md` and `GEMINI.md` remain
  git symlinks to `AGENTS.md`, on disk and in git, rather than diverging
  copies.
- **proof:** `command: node --test --test-name-pattern="is a symlink to AGENTS.md on disk" test/repo/root-pointers.test.mjs`

### R4. `docs/COMMANDS.md` is generated from the CLI's own dispatch table

- **statement:** `npm run docs` regenerates the derivable parts of the
  command manual (heading set, synopsis, flag table) from the option tables
  the CLI dispatches on, while preserving hand-authored prose by position;
  running it on the current manual yields no diff.
- **proof:** `command: node --test --test-name-pattern="manual regenerates today's file without a diff" test/cli/manual.test.mjs`

### R5. Worker-loadable references are declared and guarded

- **statement:** the set of documents a worker packet may load is declared in
  one place (`SKILL.md` plus `references/*.md`), and a fixture contract whose
  `readFiles` points under `docs/` without a matching `writeFiles` entry is
  rejected.
- **proof:** `command: node --test test/docs/reference-load.test.mjs`

### R6. Declared read bytes are measured and exposed

- **statement:** the bytes a node's declared `readFiles` weigh at dispatch
  are counted (a missing declared file counts as zero rather than throwing)
  and exposed for reporting, so the reference diet is measured by declared
  load rather than by file size alone.
- **proof:** `command: node --test --test-name-pattern="declaredReadBytes counts a missing declared file as zero rather than throwing" test/engine/declared-read-bytes.test.mjs`

## Non-goals

- Shrinking `contract.md`. The ceilings in `test/docs/docs-diet.test.mjs` are
  already working ratchets with a dated justification per increase.
- Reducing line count of any file as a goal.
- The adversarial planner and the evidence layer. They remain the next large
  blocks and do not enter here.
- Rename, domain, or any change of identity.
