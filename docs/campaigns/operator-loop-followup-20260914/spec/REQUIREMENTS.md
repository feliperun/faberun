---
id: operator-loop-followup-20260914
title: "Follow-up: durable tier-exhaustion evidence split from its own generation counter"
version: 1.0.0
status: accepted
date: 2026-09-14
owner: Felipe Broering
target: feliperun/faberun
baseline: HEAD
derived_from: SPEC-accepted.md v6 (legacy class; requirements derived from its phases and round-5 corrections)
---

# Follow-up: durable tier-exhaustion evidence split from its own generation counter

## Intent

`operator-loop-20260913`'s retrospective, carried through five adversarial
review rounds, found that clearing a node's tier-exhaustion evidence on an
unrelated outcome also silently reset the generation counter that guards
against re-counting already-tried invocations. This campaign splits the
evidence from the counter so clearing one never clears the other, and prices
`bulk-read`'s own returned envelope to match the existing usage convention.

## Requirements

### R1. Tier-exhaustion evidence and its generation counter are separate fields

- **statement:** `routing.tierExhaustion` (which candidates this generation
  tried, and their resets) and `routing.tierExhaustionCycle` (the generation
  counter) are two sibling fields; cleanup on an unrelated outcome removes
  only the evidence, never the counter.
- **proof:** `command: node --test --test-name-pattern="a node that resolves for an unrelated reason after previously carrying tierExhaustion evidence" test/engine/tier-exhaustion.test.mjs`

### R2. The reproduced round-4 regression stays fixed

- **statement:** the sequence that let a cleared generation counter fall back
  to its implicit zero and wrongly re-exclude a later generation's
  already-tried invocations no longer reproduces.
- **proof:** `command: node --test --test-name-pattern="cleanup keeps the generation counter so a later exhaustion routes by the current generation" test/engine/tier-exhaustion.test.mjs`

### R3. Retry targets the right phase and the right node after a hold

- **statement:** `retry.mjs`'s `runtime_tier_exhausted` classification computes
  the earliest reset from the recorded candidate list and holds, retries or
  rejudges accordingly, honouring the same `--node` target-closure guard the
  ordinary retry branch already applies.
- **proof:** `command: node --test --test-name-pattern="done-when 1: worker-tier exhaustion past its earliest reset retries as retry" test/engine/tier-exhaustion.test.mjs`

### R4. `supervise` neither launches too early nor calls a waiting run finished

- **statement:** a run whose only open node is `runtime_tier_exhausted` with a
  future reset reports `RunProgress.state === "waiting"` and is not launched
  until a fake clock passes that instant.
- **proof:** `judgment: true`

### R5. `bulk-read`'s own result matches the existing cost-provenance convention

- **statement:** a priced runtime's `bulkRead()` result carries
  `costProvenance: "priced"`; a provider-reported cost leaves the result's
  provenance absent while the ledger record still carries the literal
  `"provider"`, matching `run/usage.mjs`'s existing asymmetric rule.
- **proof:** `command: node --test --test-name-pattern="done-when 1: a priced runtime's successful bulkRead\(\) result carries costProvenance priced on result and ledger" test/engine/bulk-read.test.mjs`

## Non-goals

- Anything already unchanged from `operator-loop-20260913`: `next`'s rank 5
  behaviour is explicitly out of scope for this follow-up.
- Any change to the recovery-path envelopes beyond forwarding the deadline
  evidence they already carry.
