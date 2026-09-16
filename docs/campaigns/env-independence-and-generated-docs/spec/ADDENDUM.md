# Orchestrator addendum to the owner's proposal (2026-09-16)

Facts checked against `main` at 529df99 before authoring, and follow-ups from
the campaign `harden-chain-and-verification` that belong to the same classes.

## Checked facts

- `test/host/install-sh.test.mjs:157-161` reads exactly as the proposal says
  ("Keep /bin and /usr/bin for sh and tar; node lives outside both.").
- `AGENT.md`, `CLAUDE.md`, `CURSOR.md`, `GEMINI.md` are already git symlinks to
  `AGENTS.md` (mode 120000); the identical md5 is the resolved target. N3 as
  written would turn symlinks into one-line files, against the repository rule
  "never let one drift into a real file". The residue worth keeping is a test
  that asserts the four stay symlinks to `AGENTS.md` (no test enforces the rule
  today).
- `docs/COMMANDS.md` is 42,156 bytes on main (it grew with `skills register`).
- Anthropic-only judging for this loop uses the vendor independence labels
  `anthropic-sonnet` (worker) and `anthropic-opus` (judge), the convention
  `references/contract.md` already uses for `zhipu-flash`/`zhipu-pro`.

## Follow-ups to fold in

- **Test fixtures resolve node through the PATH shim.** 21 `#!/usr/bin/env node`
  fixture sites under `test/` (harnesses 4, cli 1, update 1, run/process 3,
  engine/routing 2, engine/judge 8, engine/worker-result 1, seat 1). Under the
  parallel suite on a loaded machine the asdf shim exceeded a 1.36 s assertion
  (`test/run/process.test.mjs:311`) and the 5 s notifier timeout, and cost two
  nodes their revision budget. Belongs to N2's pattern list: a fixture shebang
  must be `#!${process.execPath}`; the host-layout guard refuses `env node`.
- **finalVerification runs once per node, not once per phase.** Every node
  without dependants is phase-terminal, so a phase with three independent nodes
  runs the full suite three times and each run can flake independently.
  Candidate: run finalVerification once on the phase's integrated candidate.
- **`campaign unpark` refuses without `--force` while the run is parked**, even
  after the operator landed the run's work by hand; the message should say so
  and the coordinator should notice without a relaunch.
- **Judge verdict `fail` with only minor findings passes the gate** but status
  shows `(fail)`; show the gate outcome and the verdict separately.
