---
id: availability-is-verified-not-assumed-phase-1b
title: "The gate refuses only a node left with no runtime that answered"
version: 1.0.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: 2b7f45e
---

# The gate refuses only a node left with no runtime that answered

## Intent

R1 returning. The first attempt built the ask correctly and blocked on the
wrong rule, and the suite said so 59 times. This phase keeps the ask and
replaces the rule.

R2 landed separately: the verdict already names six failure causes plus
`ready` and `unknown`. This phase consumes that vocabulary rather than
extending it.

## What the first attempt got right, and should be reused

The prior work is at `a91ad46` and is not thrown away. Three parts of it hold
and the next attempt should start from them:

- **The ask itself.** `assertEnvironmentReady` calls `preflightContract` after
  the static checks and before any worktree or campaign event exists, and the
  evidence file is written whether it passes or blocks.
- **`await` at the call site.** The gate is async, so `scheduler.mjs` must
  await it. Un-awaited, the refusal floats off as an unhandled rejection while
  nodes dispatch, which is the difference between a gate and a formality.
- **`runHasNothingToDispatch`.** A launch whose every persisted node state
  reads `done` — the resume that replays an accepted transaction — starts no
  worker and no judge, so it can spend no availability and asks nothing. This
  is an exemption on the work, not on the environment, and it holds in
  production exactly as under test.

## Measured state

Measured 2026-09-22, `a91ad46` transplanted onto `2b7f45e`.

| Suite | Result |
| --- | --- |
| `test/engine/` | 56 failures of 385 |
| `test/run/` | 2 of 78 |
| `test/cli/` | 1 of 111 |
| `test/campaign/` | clean |
| `test/harnesses/` | clean |

The 59 failures are two shapes, and neither is a test's fault.

**A runtime with a declared failover is refused before the failover can
run.** About fifteen quota and tier exhaustion tests build a contract whose
first-choice runtime is exhausted and whose contract declares where to go
instead. The gate asks, hears `exhausted`, and blocks the whole run, so the
failover edge is never taken. This is worse behaviour in production, not only
in test: a contract declares a fallback precisely so the run proceeds when
the first choice is unavailable.

**One fake executable answers both questions.** The remaining failures are
fixtures rigged to fail the *work* — a scope violation, a bad result, a
silence that the test wants mid-run — which now also fail the *hello*,
because the same binary serves both. A real provider whose worker emits a
scope violation answers a liveness prompt perfectly well. Several of these
also cost 61 seconds each, because a silent fixture makes the gate wait out
its full 60-second budget on every launch, and the suite launches hundreds of
times.

## Requisitos

### R1. O gate pergunta, e recusa só quem ficou sem resposta

- **statement:** o gate pergunta a cada runtime roteado antes de qualquer
  despacho, e bloqueia a run apenas quando algum nó fica sem nenhum runtime
  que respondeu entre os candidatos que o contrato declara para ele. Um
  primeiro-escolhido exausto com fallback declarado não bloqueia nada: é
  exatamente o caso para o qual o fallback existe.
- **proof:** `command: node --test test/engine/live-gate.test.mjs`

## Non-goals

- Do not add a test-mode bypass, an environment escape hatch, or a skip that
  triggers when the gate believes it is under test. A gate that stops asking
  when observed is the defect this campaign exists to remove.
- Do not weaken the ask to a version check, a PATH lookup, or anything the
  provider does not answer. The campaign's whole claim is that a badge is not
  a verdict.
- Do not edit a test to make it pass. The 59 failures are the specification
  for this phase; a test that still fails at the end is a rule still wrong.
  `test/helpers.mjs` is the exception and is a fixture, not a test.
- Do not change the meaning of any reason R2 established.
- Do not touch `docs/history/`, any campaign already recorded under
  `docs/campaigns/`, or `evals/golden/`.

## Constraints

- **The verification must cover `test/engine/`.** The first attempt passed its
  own verification and its judge and still broke 56 tests there, because no
  command it ran touched the directory where the dispatch path lives. Measured
  2026-09-22: `test/engine/` serialised is 1035s, over the 600s
  `VERIFICATION_LIMITS.maxTimeoutSec` cap, so it has to be split across
  commands by file group and every group's duration measured first.
- `test/helpers.mjs` is 729 lines against an enforced ceiling of 800. If
  teaching the fixtures to answer cannot fit, say so rather than splitting the
  file.
- The gate's budget stays declared and measured. 60s against a measured 18s
  for four parallel runtimes is the current number; changing it needs a new
  measurement, not a preference.
- `CONTRACT_VERSION` stays `0.3.0`.
- `npm run typecheck` clean; no `.mjs` over 800 lines.
- No definition-of-done proof uses `--test-name-pattern`.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| Suite failures introduced by the gate | 59 | 0 | full suite |
| A node blocked while a declared fallback answered | yes | never | tests |
| Launches paying the full budget for a silent fixture | many | none | tests |
| Suites the node's verification covers | 4 of 9 | every one the dispatch path reaches | contract |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The refined rule needs the failover graph, which lives in `plan/routing` and `engine/failover`, not in `run-identity` | high | Name the reader it must consult rather than duplicating the graph; a second copy of routing is worse than the bug |
| Teaching fixtures to answer becomes a bypass by accident | high | The probe's prompt is a fixed string; answering *it* is emulation, and any condition on run context or environment is a bypass |
| A verification that covers `test/engine/` exceeds the 600s cap | medium | A constraint: split by file group with measured durations, never one directory command |
| `exhausted` fixtures are exempted to make tests pass | high | A provider out of quota is genuinely unavailable; the fix is the blocking rule, never pretending the answer was different |
