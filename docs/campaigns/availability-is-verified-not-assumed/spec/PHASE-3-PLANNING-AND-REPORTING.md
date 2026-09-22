---
id: availability-is-verified-not-assumed-phase-3
title: "Planning asks before its first stage, and a badge reader says it read a badge"
version: 1.0.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: 2fcd69e
---

# Planning asks before its first stage, and a badge reader says it read a badge

## Intent

The campaign's last phase. R4 and R5 are quoted from the owner's spec; the
measures, non-goals and constraints are this phase's own.

Phase 1 made the dispatch gate ask and phase 2 made asking cheap. Both were
about the moment a *run* starts. Two surfaces were left behind: planning,
which spends on several stages before it reaches the runtime that never
answers, and `doctor`, which reports a version check as availability while
the two honest surfaces point at it as the authority.

## Measured state

Measured 2026-09-22 at `2fcd69e`.

**Planning spends before it discovers.** `runPlanningPipeline`
(`src/plan/pipeline.mjs`) drives nine stages in order — `repo-facts`,
`draft`, `review`, `revise`, `contested`, `approval`, `routing`, `sizing`,
`freeze` — across **two** runtimes, not one: `runtimeDefaults.worker` is the
planner and `runtimeDefaults.judge` is the reviewer. The planner is spent at
`draft`. The reviewer is not reached until `review`. So a reviewer that never
answers is discovered *after* the draft has been bought, which is the shape
R4 names.

Each stage does already launch through `runContract`, so phase 1's gate fires
per stage. That is why this requirement is about *when*, not *whether*.

**Two honest surfaces defer to the one that is not.** All three use
`probeRuntime`, which is a version check; `preflightContract` is the live
ask.

| surface | says | correct? |
| --- | --- | --- |
| `models` | "declared catalogue only; live availability is `doctor`'s report" | yes |
| `models --probe` | "probed per runtime (executable reachability only); `doctor` remains authoritative" | yes |
| `doctor` (with a contract) | `harness <id>: ok` | **no — `ok` means a binary answered `--version`** |
| `doctor` (no contract) | "no contract.json provided; skipping runtime probes" | yes |

This is why disclaiming is not enough for `doctor`: the other two name it as
authoritative, so a `doctor` that only confessed would leave all three
pointing at nothing.

## Requisitos

### R4. Planejar também pergunta antes

- **statement:** `faberun plan` não inicia um estágio contra um runtime que
  não respondeu; a recusa acontece antes do primeiro estágio, não no meio do
  terceiro.
- **proof:** `command: node --test test/plan/plan-asks-first.test.mjs`

### R5. Quem só olhou o crachá diz que só olhou

- **statement:** `doctor` e `models --probe` ou reportam o veredito de quem
  falou, ou dizem explicitamente que não perguntaram; nenhum dos dois reporta
  `ok` para um runtime que nunca respondeu sem nomear o que de fato verificou.
- **proof:** `command: node --test test/cli/availability-report.test.mjs`

## Non-goals

- Do not ask once per stage. The per-stage gate already exists and phase 2
  makes a repeat ask free inside the window; a second one buys nothing.
- Do not build a second cache. `src/run/availability.mjs` is the store.
- Do not change what blocks. Silence blocks — `preflight_timeout` and
  `spawn_error` — and any verdict a provider returned is an answer.
- Do not change `src/harnesses/catalogue.mjs`: `models` is already correct
  about itself.
- Do not remove the static checks from `doctor`. A version that does not
  parse is still a finding, and the operator needs to know *which* of the two
  failed, because the remedies differ.
- Do not make `doctor` ask when it was given no contract — nothing is routed
  to ask about, and it already says so.
- Do not touch `docs/history/`, any campaign already recorded under
  `docs/campaigns/`, or `evals/golden/`.

## Constraints

- **Keep the `launch` seam injectable, and make the ask injectable the same
  way.** `test/plan` drives the pipeline through an injected launch function;
  a preflight that only fires through the real one is a preflight no test can
  reach.
- `test/host/preflight.test.mjs` passes unedited. It is the proof that a
  preflight failure keeps the run materialized, evidenced and resumable.
- `src/plan/pipeline.mjs` is 753 lines against the enforced 800 ceiling. If
  the change cannot fit, say so rather than splitting the file.
- Every node's verification covers the layer it writes, and the contract's
  final verification covers `evals/`. Both are lessons from phase 1, where a
  three-minute verification passed a change that broke 56 of 385 engine tests
  and a green local suite still failed CI on `evals/`.
- No definition-of-done proof uses `--test-name-pattern`.
- `CONTRACT_VERSION` stays `0.3.0`.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| Stages paid before a mute reviewer is found | 2 (`repo-facts`, `draft`) | 0 | tests |
| Runtimes asked before stage 1 | 0 | every one the pipeline will use | tests |
| Surfaces reporting `ok` for an unasked runtime | 1 (`doctor`) | 0 | tests |
| Surfaces that name what they checked | 2 of 3 | 3 of 3 | tests |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The pre-stage ask fires only through the real launch path, so no test reaches it | high | A constraint: injectable the same way `launch` already is |
| `doctor` loses its static findings when the live verdict is added | high | A non-goal: the live verdict sits beside them, because the remedies differ |
| A second cache appears because the planner does not see the run's store | medium | A non-goal, and the store is named in the packet |
| `pipeline.mjs` crosses the 800-line ceiling | medium | 47 lines of room, named in the packet with instructions to stop rather than split |
