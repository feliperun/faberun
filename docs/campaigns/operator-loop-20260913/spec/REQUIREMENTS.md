---
id: operator-loop-20260913
title: "Operator loop: legal deferred reads, answering a blocked question, next, and cost the operator declared"
version: 1.0.0
status: accepted
date: 2026-09-13
owner: Felipe Broering
target: feliperun/faberun
baseline: HEAD
derived_from: SPEC-accepted.md v5 (legacy class; requirements derived from its four phases)
---

# Operator loop: legal deferred reads, answering a blocked question, next, and cost the operator declared

## Intent

The 2026-09-13 deep review ran four live campaigns and found the mechanics
well proven and the operator's own loop unproven. This campaign carries the
four improvements decidable from information the system already holds: a
dependency's future output becomes a legal declared read, a blocked question
gets an answer without a new run, one command says what to do next, and a
runtime the operator priced stops being invisible in cost totals.

## Requirements

### R1. A dependency's output is a legal declared read

- **statement:** contract loading defers a missing `readFiles` verdict to
  where the dependency graph is known: a missing entry is accepted when a
  transitive dependency of that node declares the same path in `writeFiles`
  or under a `writeRoots` directory entry; every other caller stays strict.
- **proof:** `command: node --test --test-name-pattern="a direct dependency's writeFiles satisfies a deferred missing read" test/contract/deferred-reads.test.mjs`

### R2. An operator can answer a blocked question and the run continues

- **statement:** `resume --answer <node-id>=<path>` records the operator's
  answer as a persisted execution override, then re-dispatches the answered
  node and its dependants with the answer text carried into the next
  attempt's worker and judge prompts.
- **proof:** `command: node --test --test-name-pattern="resume --answer records an operator-answer override and re-dispatches only the answered node" test/engine/answer.test.mjs`

### R3. One command says what to do next

- **statement:** `next [--cwd <dir>] [--json]` prints one line per open
  campaign, chosen by the first matching predicate in rank order, is
  read-only, and takes no lock.
- **proof:** `command: node --test --test-name-pattern="prints one line per active campaign, ranked specific before generic" test/report/next.test.mjs`

### R4. Cost the operator declared is priced, never fabricated as zero

- **statement:** an optional `runtimes[<id>].pricing` object prices a
  runtime's canonical counters when the harness reports no cost; a missing
  rate for a measured counter leaves the record `unknown`, never `0`.
- **proof:** `command: node --test --test-name-pattern="done-when 1: declared rates price the canonical counters exactly" test/run/pricing.test.mjs`

## Non-goals

- A live eval class, evidence-driven routing, golden-set execution, sandbox
  work: each needs its own campaign.
- Model prices in the tree. Prices are operator data or absent.
- File delivery into an attempt worktree. An answered node receives text and
  nothing else; delivering a file is a worktree-provenance change and belongs
  in its own campaign.
- Removing comparison bias between a priced and an unpriced runtime. The
  claim is narrower: a runtime the operator priced stops being invisible.
