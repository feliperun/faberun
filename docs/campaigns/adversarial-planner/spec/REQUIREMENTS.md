---
id: adversarial-planner
title: "Adversarial planning outside the session"
version: 1.1.0
status: draft
date: 2026-09-17
owner: Felipe Broering
target: feliperun/faberun
baseline: ead7d1e
derived_from: PROPOSAL.md v1.1.0 (English restatement, same requirement ids)
---

# Adversarial planning outside the session

## Intent

Adversarial planning already exists in today's flow: two models debate a plan
inside the control session until they converge, then execution begins. The
intent is not to invent that capability, it is to move it out of the most
expensive place in the system and give it budget, isolation, determinism and
measurement — the second half of the planner proposal, built on the
deterministic stages and spec format the first half (`spec-format-and-planning-stages`)
already lands.

## Requirements

### R5. Spec authoring and review are nodes, with cost recorded

- **statement:** turning free notes into a spec, and reviewing a spec, run as
  `mode: "discovery"` nodes outside the control session, and every invocation
  is recorded in `usage.jsonl` attributed to the node.
- **proof:** `judgment: true`

### R6. The reviewer never receives the author's reasoning

- **statement:** the reviewer's packet, for both spec and plan review, carries
  only the original input, the repository facts and the artefact under review
  — never the author's own packet or reasoning output.
- **proof:** `judgment: true`

### R9. The operator's runtime instruction beats the routing table

- **statement:** a runtime the operator declares at invocation persists in the
  frozen contract and wins over the routing table.
- **proof:** `judgment: true`

### R13. Freezing a plan does not start execution

- **statement:** freezing emits a contract and stops; execution begins only on
  operator approval, whose threshold is risk-based and configurable at
  invocation.
- **proof:** `judgment: true`

### R14. Disagreement is a terminal state, not a cost sink

- **statement:** review rounds have a budget; exhausted without convergence,
  the plan ends `contested`, emits no contract, and notifies the operator with
  the open findings.
- **proof:** `judgment: true`

### R15. Planning survives the death of the seat

- **statement:** ending the control session during planning neither
  interrupts nor invalidates the plan in progress.
- **proof:** `judgment: true`

### R16. The cost of planning inside the session becomes visible

- **statement:** on a harness that exposes an allowance signal, the seat
  records the delta between campaign start and plan freeze; a harness without
  the signal records absence and does not fail.
- **proof:** `judgment: true`

### R17. Adoption of the planner is decided by measurement

- **statement:** a comparative arm runs the same specs through session
  authoring and through the planner, over at least eight specs derived from
  real campaigns — the structured `REQUIREMENTS.md` siblings and the
  preserved ledgers are the session arm's baseline — and reports a delta per
  indicator with a sample count; an indicator with no supporting record is
  null, never zero.
- **proof:** `path: docs/campaigns`

## Non-goals

- Replacing contract authoring in the session. It remains the documented
  exception path, and the fallback when the plan comes back contested or the
  repository is too unfamiliar for a closed packet.
- Industrializing deliberation. Exploring, comparing and changing one's mind
  keep happening in free conversation, outside any accounting.
- A conversation loop between author and reviewer, at any level. The reviewer
  emits findings; the author revises.
- Declaring nodes, phases or architecture in the spec. The spec declares
  intent, requirements and acceptance; deriving nodes is the planner's job.
- Planning a whole campaign at once. One phase at a time, as today.
- Changing the operator's invocation. The natural-language line pointing at a
  spec remains.
- The evidence layer and mutation testing. They remain later blocks.

## Constraints

- No packet tells the worker to run the whole suite; verification is the
  controller's, with the node's specific test file.
- Every `verification` entry has a measured duration before it carries a
  `timeoutSec`.
- One contract per phase, with every node and edge authored in one turn.
- No test depends on the wall clock, on a binary in PATH, or on machine
  layout.
- Every new document ceiling follows the dated ratchet already used in
  `test/docs/docs-diet.test.mjs`.
- No work here has line-count reduction as its objective.
- Every new worker-loadable reference respects the preamble ceiling verified
  in CI.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| `costPerClosedCheckpoint` | `evals/baseline.json` | does not rise, or rises with a higher `firstPassGateRate` | evals |
| Planning cost recorded | 0 | 100% of invocations | `usage.jsonl` |
| Seat allowance delta during planning | not measured | lower than the session arm | journal |
| Critical reviewer findings per plan | not measured | above zero | evals |
| `blockedContextRate` | `evals/baseline.json` | does not rise | evals |
| Contested plans | n/a | reported, never executed | journal |

If no indicator favours the planner arm, the correct outcome is keeping
session authoring and recording the experiment. A spec that admits only one
outcome is not an experiment.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Cold start: the planner has none of the history the session accumulated | high | repository facts cover the mechanical part; `mode: "discovery"` is the valve when a closed packet is not possible; session authoring stays available |
| The reviewer degenerates into nitpicking and burns rounds without improving the plan | medium | critical findings per plan is an explicit shutoff criterion in the success criteria |
| Planning doubles the cost with no return | medium | R16 measures the side that is invisible today; R17 decides with a number |
| Freezing accidentally starts execution | high | R13 is blocking |
| Planning turns into replanning at runtime | high | frozen plan carries a digest; execution consumes the table, never recomputes |
| The session baseline is too thin to decide from | medium | R18 of the first half preserves every ledger from now on; the 2026-09-17 manual copy recovered the ledgers still present in `.runs/` |
