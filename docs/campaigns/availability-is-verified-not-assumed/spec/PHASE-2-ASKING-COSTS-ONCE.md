---
id: availability-is-verified-not-assumed-phase-2
title: "Asking costs once per window, and the operator can force a fresh ask"
version: 1.1.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: b489e8c
---

# Asking costs once per window, and the operator can force a fresh ask

## Intent

Phase 2 of `availability-is-verified-not-assumed`, carved so the out-of-session
planner can draft it. R3 is quoted verbatim below in the owner's Portuguese;
the measures, non-goals and constraints are this phase's own.

Phase 1 made the dispatch gate ask, and accepted paying for the ask on every
launch — named as a risk rather than hidden. This phase is the payment plan.

The freshness rule already exists and is already the single home for its
semantics. What does not exist is anything that **writes** a live verdict into
the record the rule reads, and any way for the operator to say *ask again now*.

## What phase 1 actually landed, and what this phase inherits

Amended 2026-09-22 after R1 landed as `b489e8c`; this spec was carved before
it and had to be told what it now builds on.

- `assertEnvironmentReady` calls `preflightContract` on the run's own
  serialized contract, with `{ persisted: true }` so a `--base-ref` launch is
  not revalidated against a checkout its declared paths never lived in.
- The verdict per runtime is written to `env-preflight.json` under `live`, as
  `{ ok, checks: [{ id, harness, ok, liveStatus, reason, detail }] }`. That is
  the record this phase has to carry forward; it is deliberately *not* in
  `events.jsonl`, which keeps the seven fields the document declares.
- Blocking is silence only: `preflight_timeout` and `spawn_error`. Anything a
  provider actually answered — a quota refusal, an auth failure — passes.
- **`runHasNothingToDispatch` already exists and is not a window.** A launch
  whose every persisted node state reads `done` asks nothing, because it
  starts no worker and no judge. This phase must not duplicate, widen or
  fold that into the cache: it is an exemption on the *work*, and the window
  is an exemption on the *clock*. Two different questions.
- The budget is 60s, overridable by `FABERUN_PREFLIGHT_TIMEOUT_SEC`, against
  a measured 18s for four parallel runtimes.

## Measured state

Measured 2026-09-22 at `0f51681`.

**The rule exists and is deliberately centralised.** `isRuntimeAvailable`
(`src/engine/runtime-discovery.mjs:259`) already decides admission from
`available`, `exhaustedUntil`, `observedAt` and `window`, and its own comment
states the reason it is one function: *"This is the one home of the rule: plan
routing and engine composition both read it, so the null and staleness
semantics cannot drift between readers."* Its readers today are
`src/plan/routing.mjs:245,286` and `src/engine/failover.mjs:216`.

It already returns the honest answer for a stale record: an observation older
than its window *"reads as unknown and admits nothing, because unknown must
not look rested."*

**Nothing writes a live verdict into that record.** The probe's answer is
reported and discarded; `observedAt` is populated by discovery, not by the
hello.

**And the existing windows are the wrong clock.** `AVAILABILITY_WINDOW_SEC`
(`runtime-discovery.mjs:244`) is `{ five_hour: 5 * 3600, seven_day: 7 * 86400 }`
— those are the provider's **quota** windows, the period a spend allowance
resets over. *How long a hello stays good for* is a different clock and a much
shorter one. Reusing the quota window for it would conflate two things that
expire for unrelated reasons, and the campaign is about not conflating causes.

| Indicator | Today | Target |
| --- | --- | --- |
| Live verdicts persisted with their observation time | 0 | every one |
| Clocks the freshness rule distinguishes | 1, the quota window | 2, quota and hello |
| Ways for the operator to force a fresh ask | 0 | 1, and it is documented |
| Cost of a launch when a recent hello exists | one hello per runtime | zero |

## Requisitos

### R3. Perguntar custa uma vez por janela

- **statement:** o veredito é gravado com o instante em que foi observado e
  reusado enquanto estiver dentro de uma janela declarada; fora dela pergunta de
  novo; e o operador pode forçar a pergunta. Nenhuma invocação paga o oi duas
  vezes pelo mesmo runtime na mesma janela.
- **proof:** `command: node --test test/engine/live-cache.test.mjs`

## Non-goals

- Do not reuse `AVAILABILITY_WINDOW_SEC` for the hello. Those names are quota
  reset periods; a hello's freshness is its own clock and must be named
  separately even if a value happens to coincide.
- Do not move the freshness rule out of `isRuntimeAvailable`. It is the single
  home on purpose, and its comment says why. Extend it or feed it; do not fork
  it.
- Do not cache a verdict across a change of catalogue. A runtime whose model,
  harness or vendor changed is a different question, and a stale answer to a
  different question is worse than no answer.
- Do not make the cache silent. A launch that skipped the hello because a
  recent one exists says so, with when it was observed.
- Do not add a background refresher. The hello happens when something is about
  to spend, never on a timer nobody asked for.
- Do not touch `docs/history/`, any campaign already recorded under
  `docs/campaigns/`, or `evals/golden/`.

## Constraints

- `CONTRACT_VERSION` stays `0.3.0` unless a persisted field is added; if one is,
  its validator and typedef go in the same packet. `RuntimeAvailability`
  (`src/contract/runtime.mjs:176`) already validates `observedAt` and `window`
  with a three-state discipline — absent, null, or typed — and a new field must
  follow it.
- No `.mjs` file exceeds 800 lines. `runtime-discovery.mjs` and
  `run-identity.mjs` both have room.
- `npm run typecheck` clean; `noUnusedLocals` stays on.
- **No test in this phase talks to a real provider**, and none bounds a measured
  duration from above. A cache test controls the clock by injecting `now`, the
  way `isRuntimeAvailable` already accepts it — never by sleeping.
- Every directory-wide verification command declares `--test-concurrency=1` with
  its timeout measured under that flag. `test/engine/` as a directory stays out:
  1035s serialised against a 600s cap.
- No definition-of-done proof uses `--test-name-pattern`.
- One contract for the phase, every node and edge authored in one turn.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| Hellos paid for two launches inside one window | 2 per runtime | 1 | tests |
| Verdicts persisted with an observation time | 0 | every one | tests |
| Clocks the rule keeps apart | 1 | 2, named separately | tests |
| A launch that reused a verdict saying so | never, it cannot | always | tests |
| Forcing a fresh ask | impossible | one documented flag | `COMMANDS.md` |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The cache hides a provider that went down inside the window | high | The window is short by construction and the operator can force; the phase measures and declares the value rather than picking a round number |
| Reusing the quota window conflates two clocks | high | A non-goal, and a success metric: the two are named separately even if a value coincides |
| A cached verdict outlives a catalogue change and answers the wrong question | high | A non-goal: the record is keyed to what was asked, and a changed runtime is a fresh question |
| Extending `isRuntimeAvailable` makes it the home of two rules instead of one | medium | Prefer feeding it a record it already understands over adding a second concept inside it; if the rule must grow, its comment grows with it |
| A clock-injecting test drifts into sleeping | medium | A constraint: `isRuntimeAvailable` already takes `now`, so the seam exists and needs no invention |
