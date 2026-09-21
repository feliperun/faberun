---
id: state-location-and-routing-economics-phase-5
title: "Expensive suites on their own schedule, and resilience exercised"
version: 1.0.0
status: draft
date: 2026-09-21
owner: Felipe Broering
target: feliperun/faberun
baseline: c0c9562
---

# Expensive suites on their own schedule, and resilience exercised

## Intent

Phase 5 of `state-location-and-routing-economics`, the last of the spec, carved
out so the out-of-session planner can draft it. R17, R18 and R19 are quoted
verbatim below in the owner's Portuguese; the measures, non-goals and
constraints around them are this phase's own.

The spec's own ordering constraint governs: **R17 lands before R18 and R19,
which are its first two loads.** A nightly schedule with nothing to run is
idle infrastructure, and a mutation check or a resilience class with nowhere to
run blocks the merge path it was built to stay out of.

## Measured state

Measured 2026-09-21 at `c0c9562`:

- `.github/workflows/` holds three files — `ci.yml`, `pr-policy.yml`,
  `release-please.yml` — and **no `schedule:` or cron trigger anywhere**.
  Everything runs on push or pull request, including
  `node evals/run.mjs --class deterministic --assert-no-model` at `ci.yml:30`.
  There is no nightly path for anything to run on.
- **`src/engine/mutation.mjs` already exists**, and `mutation?: {threshold}` is
  already a validated field on `VerificationCommand`
  (`src/contract/verification.mjs:29`, allowed at `:109`, parsed at `:133`).
  R18 is therefore extension and wiring, not construction: the declaration and
  a module are in place, and what is missing is scoping to the node's write
  paths, a per-risk-tier threshold, and the failing behaviour.
- `evals/` carries a `deterministic` class and a `planner` class. There is no
  `resilience` class, so R19's proof command names something that does not yet
  exist.

## Requirements

### R17. A classe estocástica tem horário próprio

- **statement:** as suítes caras rodam em agenda noturna, fora do caminho de
  merge; regressão estocástica abre issue com dono declarado e não bloqueia pull
  request; a classe determinística continua bloqueando.
- **proof:** `path: .github/workflows/`
- **measure:** `command: ls .github/workflows/ && grep -n "schedule\|cron\|class" .github/workflows/*.yml | head -12`

### R18. Mutação detecta teste sem asserção

- **statement:** existe verificação de mutação escopada aos caminhos de escrita
  do nó, com limiar declarado por nível de risco, que reprova quando um teste
  não mata o mutante correspondente, e que completa dentro do orçamento de tempo
  declarado.
- **proof:** `command: node --test --test-name-pattern="mutation catches empty test"`
- **measure:** `command: grep -rn "mutation" src/contract/verification.mjs src/engine/mutation.mjs | head -12`

### R19. Resiliência é exercitada, não só documentada

- **statement:** a tabela de política de falha é exercitada em agenda noturna
  pelo driver determinístico, injetando cada classe de falha declarada, e
  nenhuma recuperação invoca modelo.
- **proof:** `command: node evals/run.mjs --class resilience --assert-no-model`
- **measure:** `command: grep -rn "class\b" evals/run.mjs | head -12`

## Non-goals

- No new expensive suite. R17 moves what exists off the merge path; it does not
  commission more work to run nightly.
- No model call in any recovery R19 exercises. `--assert-no-model` is in the
  proof command for that reason, and a resilience case that reaches a provider
  has failed regardless of its assertions.
- No change to what blocks a pull request other than moving the stochastic
  class off it. The deterministic class keeps blocking, and R17 says so.
- No change to `CONTRACT_VERSION`, which stays `0.3.0`.
- No edit to `docs/history/**`, `evals/golden/**`, or any existing file under
  `docs/campaigns/**` other than this one.

## Constraints

- **R17 first.** R18 and R19 are its loads; either one landing first would put
  an expensive check on the merge path, which is the thing this phase exists to
  prevent.
- **A nightly regression opens an issue with a declared owner and does not
  block.** An alert nobody owns is the failure mode here, not a missing alert.
- R18 is scoped to the node's own write paths. A mutation run over the whole
  tree is a different, much more expensive product and is not what the
  requirement asks for.
- R18 must complete inside a declared time budget, and that budget is a
  measurement taken on this repository, not a guess.
- Every persisted field added here needs its validator, its typedef and its
  entry in `docs/FIELD-OWNERSHIP.md` in the same change.
- `writeFiles` must account for what the change forces to change. Answer scope
  closure by declaring or acknowledging, never by dropping a write the work
  needs.

## Success criteria

| Criterion | Baseline | Target |
| --- | --- | --- |
| Workflows with a nightly trigger | 0 | one, carrying the expensive classes |
| Expensive suites on the merge path | all of them | none |
| Stochastic regression that blocks a PR | would block | opens an owned issue instead |
| Mutation scoped to a node's write paths | not run at all | every gated node, per risk tier |
| Failure classes exercised by a driver | none | every class the policy table declares |

## Risks

- A nightly job nobody reads is worse than no job: R17's issue-with-an-owner
  clause is the part that makes it real, and it is the part easiest to skip.
- R18's time budget is the requirement most likely to be met by narrowing the
  mutation set until it is fast and meaningless. The threshold is per risk
  tier for that reason, and the budget must be measured and recorded.
- R19 injects failures into a driver that also runs the deterministic class. A
  resilience case that leaks state into that class would make an unrelated
  suite flaky, which is the expensive kind of mistake to find later.
