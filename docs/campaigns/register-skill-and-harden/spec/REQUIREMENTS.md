---
id: register-skill-and-harden
title: "The installation registers the skill everywhere, and the factory absorbs its own retrospective"
version: 1.0.0
status: accepted
date: 2026-09-16
owner: Felipe Broering
target: feliperun/faberun
baseline: e0f479f
derived_from: SPEC.md (legacy class; requirements derived from its decisions and phases)
---

# The installation registers the skill everywhere, and the factory absorbs its own retrospective

## Intent

Two sources: the owner's request that installing Faberun registers the
orchestrator skill in every harness that keeps skills, and the retrospective
of `become-faberun`, whose lessons were paid for in re-runs. The campaign
runs under `faberun supervise campaign`, exercising the chain coordinator
fixed in the previous campaign end to end for the first time.

## Requirements

### R1. A worker is told what its sandbox cannot do

- **statement:** each harness adapter declares `signalsProcesses`; when the
  resolved worker declares `false`, dispatch appends a `## Sandbox` section
  naming the limitation.
- **proof:** `command: node --test --test-name-pattern="a dsh runtime gets the sandbox section" test/engine/sandbox-notice.test.mjs`

### R2. dsh workers get a clean git environment

- **statement:** the dsh adapter strips the leaked `GIT_CONFIG_COUNT`/`KEY_*`/
  `VALUE_*` family and sets `GIT_TERMINAL_PROMPT=0`.
- **proof:** `command: node --test --test-name-pattern="the dsh command removes the broken GIT_CONFIG family and sets GIT_TERMINAL_PROMPT" test/harnesses/dsh.test.mjs`

### R3. Fast repository ratchets are shared across every node's verification

- **statement:** a contract-level `sharedVerification` command list, the same
  schema as `finalVerification`, is appended to every node's attempt and
  candidate verification and counted in budgets and `preflight
  --time-verification`.
- **proof:** `command: node --test --test-name-pattern="shared verification runs on every node and precedes final verification on the phase-terminal node" test/engine/shared-verification.test.mjs`

### R4. `scopeAcknowledged` defers like `readFiles`

- **statement:** a `scopeAcknowledged` entry may name a path a transitive
  dependency creates, in its `writeFiles` or under its `writeRoots`.
- **proof:** `command: node --test --test-name-pattern="a direct dependency's writeFiles satisfies a deferred scopeAcknowledged entry" test/contract/deferred-reads.test.mjs`

### R5. Unpriced usage is visible, never rendered as free

- **statement:** a role whose invocations carry no cost is rendered as
  `unpriced` with its token totals, never as `-` or `$0`.
- **proof:** `command: node --test --test-name-pattern="an all-unpriced role renders unpriced with its tokens and the JSON says unpriced" test/report/cost.test.mjs`

### R6. Deterministic engine tests survive repetition under load

- **statement:** the seal-before-kill and judge re-ask tests are proven
  deterministic at the source, not merely tolerant of a slow machine, using
  `repeat: 4` in the node's verification.
- **proof:** `command: node --test --test-name-pattern="the judge re-ask bound survives a controller crash in either gap because it is persisted with the node" test/engine/judge.test.mjs`

### R7. `faberun skills register` links the skill into every installed harness

- **statement:** the verb discovers each installed harness's skills directory
  and links (or, with `--copy`, copies) `faberun` into it; `setup --yes`
  offers and performs it.
- **proof:** `command: node --test --test-name-pattern="register --json links faberun into claude, codex and the shared agents directory" test/cli/skills-register.test.mjs`

## Non-goals

- Pricing tables for DeepSeek (numbers unknown to the authors; `pricing` on a
  runtime remains the operator's own declaration).
- Dashboard restyle, Windows installer, organisation transfer.
- Any change to the chain coordinator itself: this campaign proves it by
  running under it.
