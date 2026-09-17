---
id: harden-chain-and-verification
title: "The retrospective of register-skill-and-harden, absorbed"
version: 1.0.0
status: accepted
date: 2026-09-16
owner: Felipe Broering
target: feliperun/faberun
baseline: 64d583a
derived_from: SPEC.md (legacy class; requirements derived from its decisions and phases)
---

# The retrospective of register-skill-and-harden, absorbed

## Intent

The first campaign of the owner's improvement loop: campaigns authored from
the previous retrospective until nothing substantial is left. Every decision
here is measured against a real incident from `register-skill-and-harden`'s
run, not a hypothetical.

## Requirements

### R1. A promotion that moves nothing records nothing

- **statement:** `promoteRun` returns `already_promoted` when the land branch
  already carries the run, and that result does not append a promotion
  record.
- **proof:** `command: node --test --test-name-pattern="recording a promotion is idempotent by run and sha" test/campaign/campaign.test.mjs`

### R2. Resume honours the launch base

- **statement:** a run launched with `run --base-ref` resumes against that
  same ref from a checkout on an unrelated commit, without a new flag.
- **proof:** `command: node --test --test-name-pattern="a run launched with --base-ref resumes against that ref from a checkout on an unrelated commit" test/engine/resume-base-ref.test.mjs`

### R3. Status moves while verification runs

- **statement:** the controller renders status on a timer while it awaits a
  verification child, and the node record names which command of how many is
  running.
- **proof:** `command: node --test --test-name-pattern="a controller verification pass records k/n progress and the running argv, and clears it on completion" test/engine/verification-progress.test.mjs`

### R4. A signal death is not a verdict

- **statement:** a verification attempt that ends by a signal the controller
  did not send is re-run once, with both attempts kept in the record and the
  first flagged.
- **proof:** `command: node --test --test-name-pattern="a signal death is retried once and passes when the retry passes" test/engine/run-command.test.mjs`

### R5. The integrated candidate re-runs only what diverged

- **statement:** when the integrated candidate fails a command the attempt
  passed, the controller re-runs exactly those commands once in the
  candidate worktree before rejecting it.
- **proof:** `command: node --test --test-name-pattern="a candidate whose every failure diverges from the attempt is retried once and passes" test/engine/candidate-retry.test.mjs`

### R6. A gate process never outlives its run directory

- **statement:** the gate exits once the directory holding its release file
  is gone.
- **proof:** `command: node --test --test-name-pattern="a gate exits once the directory holding its release file is gone" test/run/process.test.mjs`

### R7. `setup` keeps an existing config

- **statement:** with a config present and no explicit
  `--harnesses`/`--worker`/`--judge`, `setup --yes` keeps the recorded
  choices that are still available and fills only what is missing.
- **proof:** `command: node --test --test-name-pattern="setup --yes with an existing config keeps its worker and judge and narrows harnesses to what discovery still finds" test/cli/setup.test.mjs`

### R8. Notifier delivery does not hang on a grandchild process

- **statement:** notification delivery resolves on the notify binary's own
  exit, not on a grandchild process holding a stream open.
- **proof:** `command: node --test --test-name-pattern="spawnDeliver \(through NotifyQueue's default transport\) resolves on the bin's own exit, not on a grandchild holding stderr open" test/notify/notify.test.mjs`

## Non-goals

- Dashboard restyle, dsh pricing, Windows installer, organisation transfer,
  npm trusted publishing (the owner's own step).
- Any change to the chain coordinator's launch logic.
