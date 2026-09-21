---
id: state-location-and-routing-economics-phase-4
title: "Routing economics: decide on observable data, and measure before treating"
version: 1.0.0
status: draft
date: 2026-09-21
owner: Felipe Broering
target: feliperun/faberun
baseline: 29f8349
---

# Routing economics: decide on observable data, and measure before treating

## Intent

Phase 4 of `state-location-and-routing-economics`, carved out of the owner's
SPEC.md (v1.1.0) so the out-of-session planner can draft it. R12 through R16
are quoted verbatim below, in the owner's Portuguese, because the requirement
is the owner's text; everything around them — the measures, the non-goals, the
constraints — is this phase's own.

The five are one argument. Routing today picks a runtime from a table of
preferences and an availability flag. The argument is that a routing decision
should rest on what a harness actually reports (R12), that the rule doing the
deciding should say which strategy it applied and why (R13), that a node's
later attempts should prefer the runtime that already has its context unless
correctness forbids it (R14), that an operator's explicit instruction outranks
all of it (R15), and that the one obvious optimisation nobody has measured —
re-sending the same packet bytes every attempt — gets measured before anyone
decides whether to treat it (R16).

## Measured state

Measured 2026-09-21 at `29f8349`:

- `RoutingAvailability` (`src/plan/routing.mjs:13`) carries `available` and
  `exhaustedUntil` and nothing else. There is no `observedAt`, no allowance,
  and no rule that stale data reads as unknown — an absent datum is simply an
  absent key today.
- `RoutingRule` (`src/plan/routing.mjs:17`) is `{name?, when, prefer, role}`.
  **There is no `strategy` field anywhere in `src/`**, and no record on an
  assignment of why a runtime was chosen.
- Attempt-to-attempt routing lives in `src/engine/backoff.mjs`, not in a
  `src/engine/routing.mjs` — that file does not exist. Its vocabulary is hops
  and failover edges; nothing prefers the previous attempt's runtime.
- `runtimeDefaults` and `overrides` already exist in `RoutingConfig`, so R15 is
  partly present and needs its guarantee proven and carried into the frozen
  contract rather than built from nothing.
- `src/report/` mentions bytes in two places and neither is packet repetition
  between attempts.

## Requirements

### R12. O catálogo de runtime registra apenas o que é observável

- **statement:** a descoberta registra, por runtime, o que o harness de fato
  reporta: horário de reset e janela de exaustão quando existirem, allowance
  restante apenas nos harnesses que a expõem, e quando cada dado foi observado;
  dado ausente é nulo, nunca zero e nunca folga cheia, e dado mais antigo que sua
  própria janela é tratado como desconhecido.
- **proof:** `command: node --test --test-name-pattern="runtime observability catalogue"`
- **measure:** `command: grep -n "typedef\|export function" src/plan/routing.mjs | head -20`

### R13. Estratégia de roteamento é campo declarado

- **statement:** a tabela aceita uma estratégia nomeada por regra, com no mínimo
  prioridade, custo, proximidade de reset e afinidade de tentativa; a estratégia
  aplicada e o motivo da escolha ficam registrados na atribuição; estratégia que
  depende de dado não observável para o runtime em questão é inerte, não
  falha.
- **proof:** `command: node --test --test-name-pattern="routing strategy declared"`
- **measure:** `command: grep -rn "RoutingRule\|routing.table\|strategy" src/plan/*.mjs src/engine/*.mjs src/contract/*.mjs | head -20`

### R14. A afinidade de prefixo vale dentro do mesmo nó

- **statement:** tentativas e revisões sucessivas do mesmo nó preferem o runtime
  da tentativa anterior enquanto ele estiver saudável e não exausto, e cedem
  para as demais regras quando isso violaria distinção de vendor, escopo ou
  disponibilidade.
- **proof:** `command: node --test --test-name-pattern="attempt affinity yields to correctness"`
- **measure:** `command: grep -rn "nextRuntime\|hop\|currentOverride" src/engine/backoff.mjs | head -12`

### R15. A instrução de runtime do operador ganha de qualquer estratégia

- **statement:** runtime declarado pelo operador na invocação persiste no
  contrato congelado e prevalece sobre a tabela e sobre a estratégia.
- **proof:** `command: node --test --test-name-pattern="operator override wins"`
- **measure:** `command: grep -rn "runtimeDefaults\|overrides" src/plan/routing.mjs src/plan/pipeline.mjs | head -15`

### R16. A repetição de payload entre tentativas é medida antes de ser tratada

- **statement:** o relatório expõe quantos bytes de packet se repetem entre
  tentativas sucessivas do mesmo nó, para que a decisão de deduplicar seja
  tomada sobre dado; esta spec não pede deduplicação.
- **proof:** `command: node --test --test-name-pattern="report exposes repeated packet bytes"`
- **measure:** `command: grep -rn "packetHash\|bytes" src/report/*.mjs | head -15`

## Non-goals

- **No deduplication.** R16 asks for a measurement and says so explicitly. A
  node that dedupes packet bytes has answered a question this phase exists to
  ask.
- No change to `CONTRACT_VERSION`, which stays `0.3.0`.
- No live provider call to populate the catalogue: R12 records what discovery
  already observes, and an unobservable datum stays null rather than being
  fetched.
- No edit to `docs/history/**`, `evals/golden/**`, or any existing file under
  `docs/campaigns/**` other than this one.

## Constraints

- **A missing datum is null, never zero and never full allowance.** This is the
  heart of R12: a runtime that reports nothing must not look rested. The same
  applies to staleness — data older than its own window reads as unknown.
- **An inert strategy is not a failed one.** A strategy that needs data a given
  runtime does not expose must stand aside and let the remaining rules decide,
  without raising.
- **Affinity yields.** R14's preference is the weakest of the signals: vendor
  distinction, scope and availability each override it.
- Every persisted field added here needs its validator, its typedef and its
  entry in `docs/FIELD-OWNERSHIP.md` in the same change — the rule this
  repository has now paid for three times.
- `writeFiles` must account for what the change forces to change. Scope closure
  refuses a packet whose transitive imports reach an undeclared file; answer it
  by declaring or acknowledging, never by dropping a write the work needs.

## Success criteria

| Criterion | Baseline | Target |
| --- | --- | --- |
| Runtime facts carrying an observation time | none | every recorded datum |
| Absent datum distinguishable from zero | no | yes, at every reader |
| Assignments recording strategy and reason | none | every assignment |
| Later attempts preferring the previous runtime | never | whenever correctness allows |
| Repeated packet bytes visible in the report | not measured | per node, across attempts |

## Risks

- R12 and R13 are easy to over-build into a scheduler. The requirement is a
  record of what is observed and a named reason for a choice, not a new
  planner.
- R14 interacts with failover: affinity must never keep a node on a runtime the
  failover logic is trying to leave. The two are read together in
  `src/engine/backoff.mjs`.
- R16's measurement must not become a reason to dedupe in the same change. The
  spec is explicit that the data comes first.
