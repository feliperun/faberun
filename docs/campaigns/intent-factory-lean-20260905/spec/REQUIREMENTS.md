---
id: intent-factory-lean-20260905
title: "Intent Factory v0.3 \"lean\": eight rules replace eighteen"
version: 1.0.0
status: accepted
date: 2026-09-05
owner: Felipe Broering
target: feliperun/faberun
baseline: 36c55f6
derived_from: docs/history/TECH-SPEC-2026-09-05-lean.md (legacy class; requirements derived from its eight target-architecture rules)
---

# Intent Factory v0.3 "lean": eight rules replace eighteen

## Intent

Release 0.2.0's own campaign closed 22% of its nodes and spent a sixth of its
budget on accounting rather than work: distributed-systems machinery on one
laptop, four token caps that killed no real overspend, and a retry model that
minted a new run id for every failure. This campaign adopts the pattern every
established coding agent already uses — whole repository in isolation,
deterministic verification as the gate, review of the diff afterwards, retry
in place, one budget number — replacing eighteen load-bearing rules with
eight.

## Requirements

### R1. An attempt runs in its own worktree, integrated through a serialized transaction

- **statement:** every attempt runs in `git worktree add
  .runs/worktrees/<run>/<node>.<attempt>` on its own branch; the diff is the
  scope record, and an integrated candidate is verified on a scratch worktree
  before the run ref advances.
- **proof:** `command: node --test --test-name-pattern="the attempt and integration candidate worktrees get the same environment" test/repo/integration.test.mjs`

### R2. Deterministic verification is the gate; model review is advisory or blocking by choice

- **statement:** a node is `done` when its verification commands pass and the
  integrated candidate passes the same verification; review is `none`,
  `advisory` (findings recorded, node still done) or `blocking` (findings at
  or above threshold re-dispatch the node).
- **proof:** `command: node --test --test-name-pattern="skipWhen falls through when either condition fails and ordinary judgment logic applies" test/engine/judge-gate.test.mjs`

### R3. There is no spend ceiling; time and allowance are the limits

- **statement:** the schema carries no `maxInputTokens`, `maxCostUsd` or
  `usagePolicy`; `timeoutSec` and `stallTimeoutSec` bound an attempt, and
  `usage.jsonl` records tokens and cost for reporting only.
- **proof:** `command: node --test --test-name-pattern="validation rejects unknown fields at every protocol layer" test/contract/contract.test.mjs`

### R4. A retry is the same run, one attempt further, never a new contract

- **statement:** `resume <run-dir>` first adopts completed work — an
  orphaned worker result recovered rather than repeated — then re-dispatches
  ordinary failures as attempt plus one with the prior error attached.
- **proof:** `command: node --test --test-name-pattern="resume adopts an orphaned worker result instead of repeating the work" test/engine/resume.test.mjs`

### R5. One controller holds an atomic lock; a stale one is taken over safely

- **statement:** `run --detach` starts one controller that acquires the run
  lock by atomic exclusive create, recording pid and process start time; a
  contender treats the lock as stale only when the pid is dead or its start
  time differs.
- **proof:** `command: node --test --test-name-pattern="a lock whose holder pid is dead is stale and gets taken over" test/run/lock.test.mjs`

### R6. Notification carries a durable receipt

- **statement:** a terminal or attention event is delivered with a receipt
  (`delivered` or `failed`, timestamped) appended to `notify.jsonl`, even for
  a campaign-level notification with no run active.
- **proof:** `command: node --test --test-name-pattern="done-when 4: campaign-level notifications are queued and delivered with no run active" test/notify/inbox.test.mjs`

### R7. Docs fit in one sitting

- **statement:** `SKILL.md`, `references/contract.md` and
  `references/operations.md` each stay within a dated byte ceiling that
  describes only what exists.
- **proof:** `command: node --test --test-name-pattern="SKILL.md stays within the router byte ceiling" test/docs/docs-diet.test.mjs`

### R8. Runtimes are discovered and assigned by role, not hand-declared by default

- **statement:** when `runtimes`/`runtimeDefaults` are omitted, the factory
  composes them from what discovery reports available: the cheapest runtime
  executes and the strongest runtime of a different vendor judges.
- **proof:** `command: node --test --test-name-pattern="composes the cheapest worker and strongest cross-vendor judge only for omitted roles" test/engine/runtime-discovery.test.mjs`

## Non-goals

- A planner agent, a golden eval set, containers, multi-tenant operation,
  remote deployment.
- New harness drivers, changing the worker-result protocol, replacing
  Conventional Commits or the pre-commit hooks.
