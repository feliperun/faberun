# Spec: env-independence-and-generated-docs — tests that assume nothing about the machine, and a manual the code writes

Campaign `env-independence-and-generated-docs` (2026-09-16), second of the
owner's improvement loop. Source: the owner's proposal (PROPOSAL.md, pt-BR)
and the orchestrator's fact checks and follow-ups (ADDENDUM.md). Anthropic
models only: worker `claude-sonnet-5` (vendor label `anthropic-sonnet`),
judge `claude-opus-5` (`anthropic-opus`), no fallback; the controller is the
installed `~/.faberun/current` CLI.

Target: `/Users/frb/dev/frb/skills`, main at the landing of
`harden-chain-and-verification` (6a9fec1) or later.

## Decisions already made

- **Two defect classes become inexpressible, not patched.** Tests that
  encode the author's machine (where a binary lives, which version manager,
  which platform) and hand-written documentation of code surface.
- **`install.sh` is correct; its test lies.** The test builds the PATH it
  needs from symlinks to the binaries the installer actually calls, resolved
  from the current PATH before it is emptied, and never re-adds `/bin` or
  `/usr/bin`. `withEmptyPath` takes the list of binaries.
- **A host-layout guard closes the class**, in the shape of the existing
  `test/fixture-runtime-guard.mjs`: it scans `test/` and refuses PATH built
  from absolute system directories, version-manager references in
  assertions, `process.platform` inside an assertion, and fixture shebangs
  `#!/usr/bin/env node` (21 sites today; measured 2026-09-16: the asdf shim
  behind them exceeded a 1.36 s assertion and the 5 s notifier timeout under
  load). Exemption is a same-line marker with a reason,
  `guard-exempt: host-layout <reason>`.
- **Root pointers stay symlinks.** `AGENT.md`, `CLAUDE.md`, `CURSOR.md`,
  `GEMINI.md` are git symlinks to `AGENTS.md` today; a test asserts they stay
  so. No pointer file is rewritten.
- **`docs/COMMANDS.md` is generated from the tables the CLI dispatches on.**
  `src/cli/manual.mjs` reads `COMMAND_OPTIONS` and each verb module's
  `OPERATION_OPTIONS` and regenerates the derivable parts of every section
  (the heading set, the synopsis line, the flag table rows) while preserving
  the authored parts by position and flag name (description paragraph, flag
  Effect and Default cells, reads/writes paragraph, example, related line).
  Running it on today's manual yields no diff; a new flag appears as a row
  with an empty Effect cell that a test refuses; a removed verb or flag
  disappears. `npm run docs` writes, `npm run docs:check` fails when the
  file is stale, and CI runs the check. No verb, flag or exit code changes.
- **Worker-loadable references are declared and guarded.** The set is
  `skills/faberun/SKILL.md` plus `skills/faberun/references/*.md`; a packet's
  `readFiles` entry under `docs/` is refused unless the same path is in its
  `writeFiles` (a node edits what it reads). The guard runs over the eval
  fixtures' contracts. `status --json` and `report --json` expose per node
  the bytes its declared `readFiles` weigh at dispatch (`declaredReadBytes`),
  so the diet is measured by declared load, not file size alone.
- Historical documents, golden fixtures and previous campaigns' records are
  never edited. `CONTRACT_VERSION` stays `0.3.0`. The reserved articles,
  `references/contract.md` and `references/operations.md` are not touched.

## Non-goals

Shrinking `contract.md`; changing any CLI verb, flag or exit code; the
adversarial planner; the evidence layer; mutation testing; an eval case for
reference load (the deterministic cases have numeric ids and a golden set that
this campaign does not extend).

## Phase 1 — host independence (`env-independence-and-generated-docs-1-host-independence`)

1. **installer-test-builds-its-path.** 2. **host-layout-guard** (after 1).
3. **root-pointers-stay-symlinks.**

## Phase 2 — generated manual (`env-independence-and-generated-docs-2-generated-manual`)

1. **generated-command-manual.**

## Phase 3 — reference load (`env-independence-and-generated-docs-3-reference-load`)

1. **reference-load-guard.** 2. **declared-read-bytes.**

## After the campaign (orchestrator)

Land on main, full suite, push, release, `faberun update`, retrospective with
the delta against `evals/baseline.json`, close; then decide whether anything
substantial is left for the loop.
