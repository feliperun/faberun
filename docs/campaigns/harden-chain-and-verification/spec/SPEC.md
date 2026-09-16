# Spec: harden-chain-and-verification — the retrospective of register-skill-and-harden, absorbed

Campaign `harden-chain-and-verification` (2026-09-16) is the first of the
owner's improvement loop: campaigns authored from the previous retrospective
until nothing substantial is left. Source: the retrospective of
`register-skill-and-harden` (docs/campaigns/register-skill-and-harden/control/retrospective.md).
Anthropic models only: worker `claude-sonnet-5`, judge `claude-opus-5`, no
fallback. The `vendor` labels are `anthropic-sonnet` and `anthropic-opus`:
`vendor` is the operator's independence label (references/contract.md uses
`zhipu-flash`/`zhipu-pro` the same way), and the owner accepted same-company
judging for this loop. The controller is the installed `~/.faberun/current`
(0.5.0), so the engine under change never runs the chain that changes it.

Target: `/Users/frb/dev/frb/skills`, main at `64d583a` or later.

## Decisions already made

- **A promotion that moves nothing records nothing.** `promoteRun` returns
  `already_promoted` when the land branch already carries the run; that
  result must not append a promotion record. Measured 2026-09-16: two real
  promotions of contract 1 left four records after two coordinator restarts.
- **`resume` honours the launch base.** `run --base-ref` records the ref in the
  run's source identity; `resume` captures the current identity against that
  same ref, so a chain-launched run resumes from any checkout. No new flag.
- **Status moves while verification runs.** The controller renders status on a
  timer while it awaits a verification child, and the node record says which
  command of how many is running. Measured 2026-09-16: `status` reported
  `running/worker` for ten minutes of verification.
- **A signal death is not a verdict.** A verification attempt that ends by a
  signal the controller did not send (`signal` set, `timedOut` false, not
  aborted) is re-run once; both attempts stay in the record with `signalDeath`
  on the first. Measured 2026-09-16: `node --test test/engine/` SIGKILLed at
  93 s with no configured timeout.
- **The candidate re-runs only what diverged.** When the integrated candidate
  fails a command the attempt passed, the controller re-runs exactly those
  commands once in the candidate worktree before rejecting; a pass is
  accepted and recorded as retried. Measured 2026-09-16: a notifier fixture
  flake spent a node's whole revision budget.
- **A gate never outlives its run directory.** The gate exits when the
  directory of its release file is gone, and the two tests that spawn a real
  gate terminate it in a `finally`. Measured 2026-09-16: four gates from
  2026-09-15 test runs were alive the next day, deadlocked with their tests.
- **`setup` keeps an existing config.** With a config present and no explicit
  `--harnesses/--worker/--judge`, `setup --yes` keeps the recorded choices that
  are still available and fills only what is missing. Measured 2026-09-16:
  `setup --yes` replaced the owner's judge with `codex-gpt`.
- **The notifier delivery flake is measured, then fixed at the source.** The
  test fixtures now run node directly; the remaining 5 s timeouts under load
  are measured with timestamps inside the fixture before any change to
  `spawnDeliver` or its timeout.
- Historical documents, golden fixtures and previous campaigns' records are
  never edited. `CONTRACT_VERSION` stays `0.3.0`. The reserved articles are
  the orchestrator's. `references/contract.md` and `references/operations.md`
  sit exactly at their byte ceilings and are not touched by any node.

## Non-goals

Dashboard restyle, dsh pricing, Windows installer, org transfer, npm trusted
publishing (owner-side), any change to the chain coordinator's launch logic.

## Phase 1 — coordinator and resume (`harden-chain-and-verification-1-coordinator-and-resume`)

1. **idempotent-promotion.** 2. **resume-honours-base-ref.**
3. **status-during-verification.**

## Phase 2 — verification fairness (`harden-chain-and-verification-2-verification-fairness`)

1. **signal-death-retries-once.** 2. **candidate-divergence-retry** (after 1).
3. **gate-exits-with-its-run-dir.**

## Phase 3 — product and fixtures (`harden-chain-and-verification-3-product-and-fixtures`)

1. **setup-preserves-config.** 2. **notifier-delivery-measured.**

## After the campaign (orchestrator)

Land on main, full suite, push, release, `faberun update`, retrospective,
close; then author the next campaign from what is left.
