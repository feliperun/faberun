---
id: factory-autonomy-20260914
title: "The operator-loop half of the deep review: a heartbeat, parked runs, the chain, and a loop that cannot freeze"
version: 1.0.0
status: accepted
date: 2026-09-14
owner: Felipe Broering
target: feliperun/faberun
baseline: HEAD
derived_from: SPEC-accepted.md v7 (legacy class; requirements derived from its phases and done-when lists)
---

# The operator-loop half of the deep review

## Intent

The 2026-09-13 deep review found the engine's mechanics well proven and the
operator's own loop unproven: a dead controller and a working one were
indistinguishable on disk, a parked run looked finished to the watchdog, a
terminal phase could not launch the next contract on its own, and a frozen
child process could hang the drive loop forever. This campaign carries the
operator-loop half of that review: the improvements decidable from
information the system already holds.

## Requirements

### R1. A heartbeat distinguishes a dead controller from a working one

- **statement:** the controller writes `at`, `lastProgressAt`, `iteration`
  and per-node `activeNodes` to a heartbeat file; a stale `at` with a live
  lock terminates and relaunches, while a fresh `at` with `lastProgressAt`
  beyond the derived per-node budget is also treated as dead.
- **proof:** `command: node --test --test-name-pattern="done-when 1: at advances across a verification longer than 2 x interval while lastProgressAt stays put" test/engine/heartbeat.test.mjs`

### R2. A parked run is reported as parked, not as finished

- **statement:** a run whose nodes are all terminal but not all successful
  reports `parked`, naming each non-success node and status, where the
  watchdog reported it `done` before.
- **proof:** `command: node --test --test-name-pattern="done-when 1: an all-settled run that is not all successful reports parked, naming each node" test/engine/parked.test.mjs`

### R3. A terminal phase launches the next, on the previous one's landed work

- **statement:** three contracts whose runs all succeed launch in order, the
  campaign's landing branch fast-forwards after each, and the next contract's
  source identity records the commit the previous run integrated.
- **proof:** `command: node --test --test-name-pattern="done-when 1 and 2: three contracts launch in order, landBranch moves after each, and N\+1 is cut from N's commit" test/campaign/chain.test.mjs`

### R4. The managed block and the inbox say something useful to the next session

- **statement:** a run that parked appears in the managed block with its
  nodes, error codes and the exact `resume` command; `.runs/inbox.jsonl` is
  the append-only record it summarises.
- **proof:** `command: node --test --test-name-pattern="done-when 1: a parked run appears in the managed block with its nodes, codes and resume command" test/notify/inbox.test.mjs`

### R5. A frozen child process cannot freeze the drive loop

- **statement:** a child that escapes its process group and holds a pipe open
  settles from the timer with `timedOut: true` instead of waiting forever for
  `close`, and every synchronous git subprocess is bounded through one
  wrapper.
- **proof:** `command: node --test --test-name-pattern="done-when 1: a child that escapes the group and holds the pipe settles from the timer with timedOut" test/engine/unfreezable.test.mjs`

### R6. A timed-out or stalled attempt is sealed before it is killed

- **statement:** on `wall_clock_timeout` and `stall_timeout`, the attempt
  worktree is sealed before the kill, so the next attempt is cut from that
  seal with the work intact, enabling one automatic retry.
- **proof:** `command: node --test --test-name-pattern="done-when 1 and 4: a wall-clock timeout seals, auto-retries on the same runtime, and the next attempt sees the work" test/engine/seal-before-kill.test.mjs`

### R7. A node spends less per revision without losing evidence

- **statement:** a gate retry dispatches with no continuation, carrying the
  bounded previous-attempt section instead of the whole prior transcript, and
  the judge sees `{argv, passed}` for green commands with output tails only
  for red ones.
- **proof:** `command: node --test --test-name-pattern="a gate retry dispatches fresh through the real path and carries the previous-attempt evidence" test/engine/spend.test.mjs`

## Non-goals

- `status` progress line and ETA, `--brief`, `compactCost` decimals, the
  `dashboard` verb and `next` in `SKILL.md`, and the frozen `stable` build:
  campaign 2 (`operator-loop-20260913` and its follow-up).
- A hard spend ceiling: phase 6 emits an advisory line, never a stop.
- Log and worktree garbage collection: left to its own proposal.
- Provider preambles: the provider's own to trim.
