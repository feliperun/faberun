---
id: availability-is-verified-not-assumed-phase-1
title: "The gate that blocks a run asks, and the answer names the cause"
version: 1.0.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: 0911fc3
---

# The gate that blocks a run asks, and the answer names the cause

## Intent

Phase 1 of `availability-is-verified-not-assumed`, carved so the out-of-session
planner can draft it. R1 and R2 are quoted verbatim below in the owner's
Portuguese; the measures, non-goals and constraints are this phase's own.

Neither requirement builds a probe. The probe exists, it is good, and it is
called from one place that no spending path reaches. This phase moves the
answer to where the refusal already happens, and makes the answer say which
kind of failure it is.

## Measured state

Measured 2026-09-22 at `0911fc3`, on this machine.

**The gate and the asker are different code paths.**
`assertEnvironmentReady` (`src/engine/run-identity.mjs:413`) is the dispatch
gate: it writes `env-preflight.json`, blocks on failure, and leaves the run
resumable. It calls `environmentPreflight` with `reachableRuntimes(contract)`
— binary and version. `preflightContract`
(`src/engine/live-preflight.mjs`) is the asker, and its only caller in the
whole tree is `src/cli.mjs:401`, the `faberun preflight` command.

**The ask is affordable.** Against a four-runtime contract: **18 seconds**,
`usage in 5750 / 2491 / 16858` with output in the tens of tokens.

**The ask catches what the gate passes.** The same command failed
`agy-gemini-pro-judge` with `preflight_timeout: live generation timed out
after 15s`. The real cause, found afterwards by hand: no `agy` configuration
directory exists, neither `~/.config/agy` nor `~/.agy`. The binary is
installed and reports `1.2.7`, so every static check passes it. That runtime
had been declared the day before as the judge's fallback, to close an open
question, and never once consulted.

**The classification exists and is incomplete.** `availabilityFrom`
(`src/harnesses/index.mjs:240`) already returns a `reason` carrying `ready`,
`quota_exhausted`, `insufficient_balance` and `provider_unavailable`. What it
cannot yet say apart: a credential that is absent, and a model this account
may not use. And `preflight_timeout` names the symptom, not the cause — an
unauthenticated harness and a slow model reach it identically.

**Room to work.** `live-preflight.mjs` 300 lines, `run-identity.mjs` 432,
`host/preflight.mjs` 548, `contract/runtime.mjs` 259 — all under the 800 ceiling.

| Indicator | Today | Target |
| --- | --- | --- |
| Callers of `preflightContract` | 1, a manual command | the dispatch gate too |
| Runtimes the gate passes without an answer | all of them | none |
| Causes the verdict tells apart | 4 codes, 2 of them missing | 4, plus an explicit unknown |
| Cost of asking four runtimes | 18s | unchanged |

## Requirements

### R1. O portão que bloqueia usa o veredito de quem falou

- **statement:** o portão de despacho que hoje aprova por binário e versão passa
  a exigir que cada runtime roteado tenha respondido; um runtime que não
  respondeu bloqueia o run antes de qualquer worktree ou evento de campanha
  existir, com a mesma resumibilidade que o portão já oferece.
- **proof:** `command: node --test test/engine/live-gate.test.mjs`

### R2. O veredito nomeia qual das quatro causas

- **statement:** o resultado por runtime distingue binário ausente, não
  autenticado, modelo indisponível para a conta, e cota ou provedor fora; um
  tempo esgotado sem causa discernível é reportado como tal e não como uma das
  quatro.
- **proof:** `command: node --test test/engine/live-verdict.test.mjs`

## Non-goals

- Do not rewrite `live-preflight.mjs`. It is correct; what is missing is a
  caller.
- Do not weaken `safeLiveRuntime`. The ask stays clamped to read-only, in a
  throwaway repository, with provider strings redacted before they are logged.
- Do not add caching in this phase. R3 owns it, and a gate that asks every
  launch is the honest intermediate state — better a known cost than a silent
  pass.
- Do not guess a cause from silence. A timeout with no discernible cause is
  reported as unknown; inventing `quota_exhausted` from a slow answer would be
  the same defect this campaign exists to remove.
- Do not authenticate `agy`, or change any runtime catalogue. The catalogue is
  the operator's; the product's job is to tell the truth about it.
- Do not touch `docs/history/`, any campaign already recorded under
  `docs/campaigns/`, or `evals/golden/`.

## Constraints

- `CONTRACT_VERSION` stays `0.3.0` unless a persisted field is added; if one is,
  its validator and typedef go in the same packet.
- No `.mjs` file exceeds 800 lines.
- `npm run typecheck` clean; `noUnusedLocals` stays on.
- **No test in this phase talks to a real provider.** The ask is exercised
  through a fixture harness; a test that spends a token is a test that fails
  without a network, and this repository's suite must run offline.
- Every directory-wide verification command declares `--test-concurrency=1`
  with its timeout measured under that flag. `test/engine/` as a directory
  stays out: measured serialised at 1035s against a 600s cap.
- No definition-of-done proof uses `--test-name-pattern`; point it at a file.
- A test that reads what another process writes waits for a readiness signal,
  and the signal is written after the thing it announces.
- The gate's refusal stays resumable and writes its evidence either way, exactly
  as `assertEnvironmentReady` does today.
- One contract for the phase, every node and edge authored in one turn.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| Spending launches that ask first | 0 | every one | tests |
| Runtimes passed by the gate without answering | 4 of 4 in this catalogue | 0 | tests |
| Causes told apart by the verdict | 2 of 4, plus a conflated timeout | 4, plus explicit unknown | tests |
| A declared runtime that never answers reaching dispatch | happened, 2026-09-21 | refused at the gate | tests |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Every launch now pays the ask | high | Accepted for this phase and named as such; R3 adds the window. A known cost beats a silent pass |
| A slow provider is classified as unavailable and blocks a good run | high | R2 requires unknown to be a real answer, and the ask's budget is declared rather than implicit |
| The gate's new refusal is not resumable and a launch is lost | high | A constraint: the refusal keeps the shape `assertEnvironmentReady` already has, evidence written either way |
| A test reaches a real provider and the suite stops working offline | high | A constraint, and a success metric: the fixture harness is the only path |
| Classifying causes needs per-harness knowledge that rots | medium | `availabilityFrom` already owns this and already carries four codes; the phase extends one function rather than spreading the knowledge |
