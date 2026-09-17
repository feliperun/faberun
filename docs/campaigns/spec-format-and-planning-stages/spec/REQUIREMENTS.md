---
id: spec-format-and-planning-stages
title: "A validated spec format, the planner's deterministic stages, and ledgers that outlive their campaign"
version: 1.1.0
status: draft
date: 2026-09-17
owner: Felipe Broering
target: feliperun/faberun
baseline: 5857b44
derived_from: PROPOSAL.md v1.1.0 (English restatement, same requirement ids)
---

# A validated spec format, the planner's deterministic stages, and ledgers that outlive their campaign

## Intent

First half of adversarial planning outside the session. Everything here is
testable without invoking a model: the spec format and its validator, the
deterministic repository inventory, the routing table, graph sizing, and
freezing with a digest. These are the safety net for the model-invoking nodes
of the second half (`adversarial-planner`), and landing them early gives that
campaign a validated spec to consume. It also carries the urgent fix of an
ongoing data loss: every closed campaign today discards its ledger, and that
ledger is what the second half's comparative arm needs as a baseline.

## Requirements

### R1. The spec format is versioned and documented

- **statement:** a spec format exists with its own version, documented as a
  worker-loadable reference, whose mandatory sections are Intent,
  Requirements and Non-goals.
- **proof:** `path: skills/faberun/references/spec-format.md`
- **constraints:** the new reference raises three ratchets with a dated
  justification, in the pattern of `test/docs/docs-diet.test.mjs`: the
  references-directory byte ceiling, the assertion that names every document
  under it, and the 1,024-byte `SKILL.md` ceiling that grows to link the
  reference. The reserved articles are untouched.

### R2. Spec validation is deterministic

- **statement:** validating a spec invokes no model.
- **proof:** `command: node --test --test-name-pattern="spec validate invokes no model"`

### R3. Validation rejects a spec that would burden planning

- **statement:** a requirement with no stable id, a requirement with no
  `proof`, an absent Non-goals section, a success criterion with no baseline,
  and a `target` or `baseline` that does not resolve to a commit are
  rejected; advisory by default, blocking under `--strict-traceability`.
- **proof:** `command: node --test --test-name-pattern="spec validate rejects"`

### R4. New specs validate; existing records are an accepted class

- **statement:** the validator recognizes a document with no structured front
  matter as `legacy` and accepts it without failing, saying so; the proof
  covers every spec written from this campaign on and a structured
  `REQUIREMENTS.md` generated beside every `PROPOSAL.md`/`SPEC.md` already
  under `docs/campaigns/`, without altering a byte of the originals or of
  `docs/history/`.
- **proof:** `command: node --test --test-name-pattern="existing specs validate"`

### R7. Repository facts are deterministic and carry measured duration

- **statement:** the target repository's inventory is generated without
  invoking a model, is identical across two runs at the same HEAD, and every
  candidate verification command carries a duration measured by
  `preflight --time-verification`.
- **proof:** `judgment: true`

### R8. The model classifies, the table routes

- **statement:** the plan draft returns a classification per node and never
  names a runtime; runtime resolution comes from a declarative table crossed
  with what discovery reports as available and not exhausted.
- **proof:** `judgment: true`

### R10. A generated plan's judge never shares a vendor with the worker or its fallback

- **statement:** no generated plan resolves a judge whose vendor label
  matches a node's worker or any runtime in that worker's fallback chain; the
  requirement names no mechanism, and the proof reuses the same invariant the
  contract validator already imposes.
- **proof:** `command: node --test --test-name-pattern="a gate-enabled node whose worker and judge runtime share a vendor is rejected by name" test/contract/runtime.test.mjs`

### R11. Graph sizing is deterministic and auditable

- **statement:** merging, splitting and marking nodes parallelisable are
  post-processing decisions with no model, idempotent, and every
  transformation records the rule that caused it.
- **proof:** `judgment: true`

### R12. A frozen plan is reproducible

- **statement:** the plan carries a digest, package version, `schemaVersion`,
  the target's git HEAD, the runtime pair that planned and reviewed it, the
  sizing rules applied, and the reviewer's findings with severity; altering
  one byte invalidates the digest.
- **proof:** `judgment: true`

### R18. A closed campaign preserves its ledger

- **statement:** closing a campaign copies each linked run's `usage.jsonl`
  and the campaign journal into the registry under `docs/campaigns/<id>/`,
  redacted by the redactor the capsule already uses, outside `.runs/`. It
  enters early in the campaign: every day without it is one fewer data point
  for the comparative arm.
- **proof:** `command: node --test --test-name-pattern="campaign close preserves ledger"`

## Non-goals

- Any model-invoking node: spec authoring and review, the planning contract,
  `faberun plan`, the comparative arm and the allowance. They belong to the
  second campaign (`adversarial-planner` v1.1.0).
- Declaring nodes, phases or architecture in the spec. The spec declares
  intent, requirements and acceptance; deriving nodes is the planner's work
  (the orchestrator's, until it exists).
- Rewriting any document under `docs/campaigns/` or `docs/history/`.
- Changing the operator's invocation.

## Constraints

- No packet tells the worker to run the whole suite; verification is the
  controller's, with the node's specific test file.
- Every `verification` entry has a measured duration before it carries a
  `timeoutSec`.
- One contract per phase, with every node and edge authored in one turn.
- No test depends on the wall clock, on a binary in PATH, or on machine
  layout.
- Every new document ceiling follows the dated ratchet of
  `test/docs/docs-diet.test.mjs`.
- No work here has line-count reduction as its objective.
- `src/plan/` is a new layer and enters `AGENTS.md`'s layout table.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| Validatable campaign specs | 0 | every new one, plus one `REQUIREMENTS.md` per record | validator |
| Preserved ledgers of closed campaigns | 0 | 100% of campaigns closed from now on | registry |
| Contracts with `timeoutSec` below the real duration | occurred in the field | zero in frozen plans | `preflight` |
| Deterministic, model-free stages | n/a | four, each proven by fixture | tests |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The spec format becomes a chore and the operator returns to free markdown | medium | three mandatory sections, advisory validation by default, scaffold by command |
| The routing table becomes configuration parallel to the contract | medium | declared precedence, with the operator's override always winning |
| A preserved ledger carries something that should not be public | medium | the capsule's own redactor applied to the copy; the pre-commit hook scans it |
