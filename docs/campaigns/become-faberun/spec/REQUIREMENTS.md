---
id: become-faberun
title: "The repository becomes Faberun"
version: 1.0.0
status: accepted
date: 2026-09-16
owner: Felipe Broering
target: feliperun/faberun
baseline: HEAD
derived_from: SPEC.md (legacy class; requirements derived from its decisions and phases)
---

# The repository becomes Faberun

## Intent

Turn this repository from a personal skills catalogue that happens to contain
a tool into the home of that tool, renamed Faberun, and run that
transformation through the tool itself: every node executed by a Faberun
worker, verified by Faberun's own verification and judged by a cross-vendor
judge.

## Requirements

### R1. No live file carries the previous brand name

- **statement:** every live occurrence of `intent-factory`/`Intent Factory`/
  `INTENT_FACTORY` becomes `faberun`/`Faberun`/`FABERUN`, asserted by a
  ratchet over the live tree (historical documents and golden fixtures are
  exempt).
- **proof:** `command: node --test --test-name-pattern="no live file carries the previous brand name" test/repo/brand.test.mjs`

### R2. The package identity is Faberun

- **statement:** `package.json` names the package `faberun` with
  `bin/faberun.mjs` as its entry point.
- **proof:** `command: node --test --test-name-pattern="package.json names the package faberun and its entry point bin/faberun.mjs" test/repo/brand.test.mjs`

### R3. The CLI can update itself

- **statement:** `faberun update [--check] [--json]` fetches the latest
  release, verifies the new version's `--version` before moving `current`,
  and reports a checked cache without installing under `--check`.
- **proof:** `command: node --test --test-name-pattern="update installs a newer release and moves current" test/cli/update.test.mjs`

### R4. First-run onboarding chooses harnesses and roles

- **statement:** `faberun setup [--yes] [--harnesses a,b] [--worker <id>]
  [--judge <id>] [--json]` discovers installed harnesses, chooses a worker
  and a cross-vendor judge, and writes the user config.
- **proof:** `command: node --test --test-name-pattern="setup --yes writes the cheapest worker and a cross-vendor judge" test/cli/setup.test.mjs`

### R5. A target repository can be bootstrapped for campaigns

- **statement:** `faberun init [--cwd <dir>] [--yes] [--no-skill]
  [--agentkit] [--greenfield|--stable]` ignores `.runs/`, installs the
  `faberun` skill, and optionally runs the agent-kit installer.
- **proof:** `command: node --test --test-name-pattern="init --yes ignores .runs, installs the skill, and skips the agent kit" test/cli/init.test.mjs`

### R6. The skills catalogue is managed by a CLI verb

- **statement:** `faberun skills list|install` replaces the standalone
  installer script, copying the named skill (or the whole catalogue) into a
  `.claude/skills/` directory.
- **proof:** `command: node --test --test-name-pattern="install puts the catalogue under .claude/skills" test/cli/installer.test.mjs`

### R7. A parked campaign has a way back

- **statement:** `faberun campaign unpark <id>` clears a parked campaign's
  `attention` once the referenced run is no longer parked, appending a
  `campaign.unparked` journal event.
- **proof:** `command: node --test --test-name-pattern="unpark refuses a still-parked run, then clears the attention once it is done" test/campaign/unpark.test.mjs`

### R8. User-facing documentation replaces evolution-internal docs

- **statement:** a real README, vision, concepts, command manual and
  getting-started path exist and the command manual is generated from the
  CLI's own dispatch table rather than hand-maintained.
- **proof:** `command: node --test --test-name-pattern="manual regenerates today's file without a diff" test/cli/manual.test.mjs`

### R9. Faberun has a visual identity of its own

- **statement:** the hornero-nest mark and the five-color palette are
  recorded as the product's design specification.
- **proof:** `path: DESIGN.md`

## Non-goals

- Restyling the web dashboard to `DESIGN.md` (a follow-up).
- Publishing to npm; transferring the repository to an organisation.
- Rewriting historical documents or golden fixtures.
- Windows support for `install.sh` (a PowerShell installer is a follow-up).
- Any change to the contract schema or the judge protocol.
