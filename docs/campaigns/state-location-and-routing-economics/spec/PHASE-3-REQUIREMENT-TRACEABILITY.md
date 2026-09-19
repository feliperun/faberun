---
id: state-location-and-routing-economics-phase-3
title: "Requirement traceability: from the frozen plan to the closed ledger"
version: 1.0.0
status: draft
date: 2026-09-19
owner: Felipe Broering
target: feliperun/faberun
baseline: 51f46c7
---

# Requirement traceability: from the frozen plan to the closed ledger

## Intent

Phase 3 of `state-location-and-routing-economics`, carved out of the owner's
own SPEC.md (v1.1.0) so the out-of-session planner can draft it. R9, R10 and
R11 are quoted verbatim below, in the owner's Portuguese, because the
requirement is the owner's text and paraphrasing it here would make this file
disagree with the spec it comes from. Everything this file adds around them --
the measures, the non-goals, the constraints -- is this phase's own.

The three requirements are one thread and only pay off together: a phase
declares which requirements it satisfies (R9), those identifiers survive into
the node the phase becomes (R10), and closing the campaign confronts what was
declared against what was actually verified (R11). Any one alone leaves the
chain broken at the next link.

## Measured state

No source file under `src/` mentions `requirementIds` today (measured
2026-09-19, `51f46c7`): none of the three requirements has any implementation
to extend, so all three are greenfield rather than repair. The plan freeze
(`src/plan/freeze.mjs`) and the plan template (`src/plan/template.mjs`) are
where a phase's declared shape is decided; the contract and its snapshot
(`src/contract/`) are where a node's persisted fields live; closing is in
`src/campaign/index.mjs`, reached from `src/cli/campaign.mjs`.

## Requirements

### R9. O plano declara quais requisitos cada fase atende

- **statement:** o plano congelado declara, por fase, os identificadores de
  requisito que ela atende e o entregável que produz, em uma frase; fase sem
  requisito associado é reportada pela validação de plano.
- **proof:** `command: node --test --test-name-pattern="plan phase declares requirements"`
- **measure:** `command: grep -n "@typedef" src/plan/freeze.mjs src/plan/template.mjs | head -40`

### R10. O identificador de requisito viaja até o nó

- **statement:** o contrato preserva, por nó, os identificadores de requisito
  herdados da fase, e o resultado de worker os carrega de volta sem que o worker
  precise declará-los.
- **proof:** `command: node --test --test-name-pattern="requirement ids reach the node"`
- **measure:** `command: grep -rln "phase" src/contract/*.mjs src/engine/*.mjs | head -40`

### R11. O encerramento confronta entregue com pretendido

- **statement:** encerrar uma campanha grava no registro, deterministicamente e
  sem invocar modelo, o mapa de requisito para nó para evidência de verificação,
  marcando requisito não coberto como aberto em vez de omiti-lo; a correlação sai
  dos identificadores carregados, nunca de casamento por texto.
- **proof:** `command: node --test --test-name-pattern="closure maps requirements to nodes"`
- **measure:** `command: grep -n "requirement\|ledger\|REQUIREMENTS" src/campaign/index.mjs | head -40`

## Non-goals

- No retroactive backfill: campaigns already closed keep the records they
  have. Requirement traceability starts with plans frozen after this phase.
- No model call anywhere in closure. R11's map is derived from identifiers the
  contract already carries; text matching between a requirement statement and
  a node id is explicitly the wrong mechanism and must not appear.
- No change to `CONTRACT_VERSION`, which stays `0.3.0`.
- No edit to `docs/history/**`, to `evals/golden/**`, or to any existing file
  under `docs/campaigns/**` other than this one, which this phase authored.

## Constraints

- A worker must never have to declare a requirement identifier: R10 is
  satisfied by the contract carrying what the phase already declared, not by
  asking the worker to repeat it.
- A phase with no associated requirement is a validation finding, not a
  silent pass, and not a hard refusal either -- some phases (a spike, a
  discovery node) legitimately satisfy no requirement.
- Every persisted field added here needs its validator and its typedef in the
  same change: a new field on a snapshot, an identity or a `run.json` is the
  rule this repository has already paid for twice.

## Success criteria

| Criterion | Baseline | Target |
| --- | --- | --- |
| Frozen phases carrying requirement ids | 0 | every phase of a plan frozen after this lands |
| Requirement ids readable from a node without the worker declaring them | none | every node of such a plan |
| Closure records naming an uncovered requirement as open | none | every close after this lands |

## Risks

- The identifier has to survive three format boundaries (frozen plan,
  contract, node snapshot). Each boundary has its own validator, and a field
  added to one and forgotten at the next fails closed rather than silently, so
  the risk is scope creep across validators rather than data loss.
- R11's determinism is easy to lose: any fallback that reaches for a model, or
  for text similarity, when an identifier is missing would defeat the point.
  An uncovered requirement must read as open.
