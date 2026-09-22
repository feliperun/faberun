---
id: durable-state-integrity-phase-5
title: "Cancel is verified against an invocation that is genuinely alive"
version: 1.0.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: a74244d
---

# Cancel is verified against an invocation that is genuinely alive

## Intent

Phase 5 of `durable-state-integrity`, carved so the out-of-session planner can
draft it. R10 is quoted verbatim below in the owner's Portuguese; the measures,
non-goals and constraints are this phase's own.

`cancelRun` carries a whole termination subsystem — signal the controller,
wait for the process to actually die rather than assume, escalate SIGTERM to
SIGKILL, terminate every recorded invocation, refuse if one is still alive
afterwards — and none of it runs in any test today. Phase 1 then added an
ordering to the same function: every preserved ref is created before the first
release, so a cancel that dies part-way leaves more work reachable, never less.
That ordering is precisely what a live process, and a kill that takes time,
would disturb.

The gap was carried into this campaign from the roadmap as RM-003, and this
phase is where it closes.

## Measured state

Measured 2026-09-22 at `a74244d`, by reading the tests rather than recalling
them.

Every cancel test builds its state the same way: `runContract` is driven to
completion under `withFakeCodex`, and then `orphan(runDir, "build")` rewrites
the finished node's state file to `status: "running", phase: "worker",
result: null, gate: null` (`test/helpers.mjs:83`). That is a synthetic running
state with **no live process behind it**.

So on every run of the suite:

| path in `cancelRun` | exercised today |
| --- | --- |
| `signalController` SIGTERM, then SIGKILL after 2s | no |
| `waitForProcessDeath`, and the throw when it times out | no |
| `terminateInvocation` for a recorded invocation | no |
| the refusal when an invocation is still alive after cancellation | no |
| verification attempts terminated and marked `canceled` | no |
| preserved refs created before the first release | yes, but with nothing running |

Six of the function's failure paths have never executed. The one that has —
phase 1's ordering — has only ever run against a tree nobody was writing to.

A related fact this phase should not conflate: on 2026-09-21 a node of this
campaign reached the terminal state `canceled` because the **provider** turn
was cancelled upstream, not because anyone cancelled the run. That is a
separate finding, recorded as its own open question.

## Requirements

### R10. `cancel` é verificado contra invocação genuinamente viva

- **statement:** existe verificação de `cancel` contra uma invocação de fato em
  execução, com processo vivo: o cancelamento sinaliza, confirma a morte em vez
  de presumi-la, recusa se alguma invocação sobreviver, e a ordem que a fase 1
  estabeleceu — todo ref preservado criado antes da primeira liberação —
  continua valendo quando a terminação leva tempo.
- **proof:** `command: node --test test/engine/cancel-live-invocation.test.mjs`

## Non-goals

- Do not replace the existing cancel tests. They cover the terminal-state paths
  and stay; this phase adds the live one beside them.
- Do not test against a real provider. The live process must be a fixture the
  test starts and owns, so the suite stays free of network, quota and binaries
  on `PATH`.
- Do not conflate a provider-side cancelled turn with an operator cancel. That
  is a real finding and it is recorded separately; this phase is about the
  operator's `cancel` verb.
- Do not bound any measured duration from above. Proving a kill happened is a
  lower bound on elapsed time, never an upper one.
- Do not leave a process behind. A test that starts a live process and fails
  must still reap it, or the suite grows the orphan-fixture problem this
  repository has already paid for.
- Do not touch `docs/history/`, any campaign already recorded under
  `docs/campaigns/`, or `evals/golden/`.

## Constraints

- `CONTRACT_VERSION` stays `0.3.0`. This phase adds no contract field.
- No `.mjs` file exceeds 800 lines. `src/engine/cancel.mjs` is at 202 after
  phase 1, so it has room if it needs any change at all — and it may need none.
- `npm run typecheck` clean; `noUnusedLocals` stays on.
- Every directory-wide verification command declares `--test-concurrency=1`
  with its timeout measured under that flag.
- No definition-of-done proof uses `--test-name-pattern`; point it at a whole
  file. The rule and its measurement are in `AGENTS.md`.
- A live-process fixture is reaped in a `finally`, not on the happy path, and
  the test asserts the process is gone before it returns.
- One contract for the phase, every node and edge authored in one turn.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| `cancelRun` failure paths executed by the suite | 0 of 6 | every one reachable without a provider | tests |
| Cancel tests running against a live process | 0 | at least one | tests |
| Processes left behind by the new test | 0, since it does not exist | 0 | tests |
| Phase 1's ref-before-release ordering proven under a slow kill | no | yes | tests |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A live-process test is flaky on a loaded machine | high | No upper bound on any duration; the fixture ignores SIGTERM deliberately so the escalation is deterministic rather than timing-dependent |
| The fixture outlives a failing test and joins the orphan processes this repository has collected before | high | A constraint: reaped in `finally`, and the test asserts it is gone |
| Proving the ordering needs a fault injection that changes production code | medium | Prefer a fixture whose termination is slow by construction over a code seam added only for the test |
| The new test is slow enough to push a verification command past 600s | medium | It is one file with a handful of processes; measure it and declare the timeout from the measurement |
