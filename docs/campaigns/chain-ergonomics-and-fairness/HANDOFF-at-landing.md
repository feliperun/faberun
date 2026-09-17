# campaign chain-ergonomics-and-fairness handoff

Updated: 2026-09-17T17:59:59.340Z

## Goal

The six defects the loop's four chained campaigns left in the factory itself, all of them ergonomics or fairness rather than correctness: a run launched with --base-ref validates against that ref so a chained contract reading the previous phase's files launches from any checkout; the refusals on the campaign path name the way forward; a free slot dispatches while another node verifies; the contract's final verification runs once per phase instead of once per terminal node; and the status names the candidate stage and distinguishes a gate that passed from a fail verdict. Anthropic models only. Spec: docs/campaigns/chain-ergonomics-and-fairness/spec/SPEC.md.

## Latest next action

None.

## Session lineage

None.

## Active decisions

None.

## User constraints

None.

## Open questions

None.

## Linked runs

- chain-ergonomics-and-fairness-1-launch-and-refusals: 2 nodes · 1 blocked · 1 done
  - base-ref-validation: blocked · src/engine/scheduler.mjs (read+write): runContract() re-validates the contract from disk independently of any pre-check in src/cli.mjs, and that call has no baseRef parameter; it must be made ref-aware (e.g. reuse validateContractAgainstRef from src/campaign/chain.mjs with the pending launch base…
- chain-ergonomics-and-fairness-2-throughput-and-truth: 3 nodes · 3 exhausted
  - dispatch-during-verification: exhausted · The core of the change is sound: `settleClosedJobsInBackground` (scheduler.mjs:437-462) frees the slot and enqueues the settlement synchronously, so a sibling dispatches while another node's controller verification, judge round or candidate verification runs; different nodes' settlements are stil…
  - final-verification-once-per-phase: exhausted · deterministic verification failed
  - status-tells-the-truth: exhausted · Most of the objective lands. Candidate verification now names its own phase end to end: `verifyCandidateWorkspace` marks `verification.candidate` and persists it with `writeNode` before the pass and clears it in a `finally` (verify.mjs:243-279), `settleDone` threads the lock so the write is legal…
- chain-ergonomics-and-fairness-1b-base-ref-validation: 1 nodes · 1 done
- chain-ergonomics-and-fairness-2b-fairness-fixes: 3 nodes · 3 done

## Recent user intents

None.

## Attempts and outcomes

- run chain-ergonomics-and-fairness-1-launch-and-refusals: Run 1: refusals-name-the-way-forward done on the first attempt and promoted; base-ref-validation blocked with a finding sharper than my packet -- the CLI pre-check is not the only validation, src/engine/scheduler.mjs runContract() re-validates from disk with no baseRef, so a CLI-only fix would pre-validate a launch that then fails inside the run. Superseded by contract 1b with the scheduler in scope. USD 3.67. · claude-control-chain-ergonomics · 2026-09-17T15:31:59.697Z
- run chain-ergonomics-and-fairness-1b-base-ref-validation: Run 1b done on the first attempt: a run launched with --base-ref validates against that ref at both call sites (the CLI pre-check and the scheduler's runContract), so a chained contract reading the previous phase's files launches from any checkout -- the engine defect that cost this loop three operator interventions is closed. Promoted; the coordinator launched contract 2. USD 2.90. · claude-control-chain-ergonomics · 2026-09-17T16:08:06.808Z
- run chain-ergonomics-and-fairness-2-throughput-and-truth: All three nodes of phase 2 exhausted with judge-confirmed work and one precise remaining gap each. The orchestrator landed the three attempts by hand onto the land branch: c022e64 a free slot dispatches while another node verifies; 1388c92 the contract's final verification runs once per phase; 6212d85 the status names the candidate phase and the gate outcome, resolving the verify.mjs conflict by keeping both the once-per-phase selection and the candidate phase marker. Contract 2 is replaced in the manifest by 2b-fairness-fixes: three nodes authored from the judges' verbatim findings, chained d14-case-proves-once-per-phase then judge-branch-on-the-settlement-queue then dashboard-shows-the-gate-outcome, so the D14 discriminator is green before any node runs the full suite. · claude-control-chain-ergonomics · 2026-09-17T17:59:29.597Z

