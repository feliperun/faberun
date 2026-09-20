---
id: orchestration-arms
title: "Does orchestrating with faberun beat one session, or one session with its own subagents?"
version: 1.1.0
status: draft
date: 2026-09-20
owner: Felipe Broering
target: feliperun/faberun
baseline: a1117f7
---

# Does orchestrating with faberun beat one session, or one session with its own subagents?

## Intent

Faberun's premise is that a closed packet per node, a fresh session per attempt, a mechanical proof and an independent judge deliver more per dollar and per hour than one agent doing everything in one context. That premise has never been measured against the two obvious alternatives an operator has at hand: give the whole job to one session of the same model, or give it to one session that delegates to the harness's own subagents. This campaign measures all three on the same work, the same model, the same base commit, with repetitions and a noise band, and reports a result only where the difference is larger than the noise.

The question is stated as three arms and two comparisons:

- **Arm A, faberun.** One contract with one node per requirement, the product's closed execution packet, the write scope enforced at the tool boundary, the requirement's proof as the node's verification, a blocking cross-vendor judge with one revision, `maxParallel` 3 and the product's attempt bounds (150 requests, wall clock, stall).
- **Arm B, single session.** One `claude -p` session, the same model and permission mode as arm A's workers, the same built-in tools, given every requirement at once with the same text, write scope, relevant files and proof command a faberun node gets, and told to run the proofs.
- **Arm C, session with subagents.** Arm B plus the Agent tool and one paragraph telling it to delegate each requirement to a subagent, run independent ones in parallel and integrate.
- **Arm D, faberun with the proof as the only gate.** Added after the pilot (version 1.1.0): arm A without the judge, `gate: false`, the configuration the product documents for a fully mechanical node. The pilot measured the judge at 42% of arm A's cost and arm A's worker-only cost equal to one session's whole cost, so the orchestration and the judge have to be measured apart to say which one the premium belongs to.

Comparison 1 is A against B; comparison 2 is A against C. B against C is reported because it falls out for free and says whether native delegation is the cheaper half of orchestration. D against B and D against C say what the orchestration costs without the judge.

## Estado medido

Before any arm ran, the stored runs under the user's faberun home were measured (2026-09-20): a claude worker turn makes a median of 49 provider requests and re-reads a context that grows 1.9x within the turn; 98-99% of that context is served from cache in every harness; a turn opened on a phase sibling's session cost 1.87x a fresh one; the 23 turns that produced nothing held 25% of all context spend. The same packet on the same model varied by a factor of 3.3 across 10 repetitions in one earlier campaign and 2.12 across 2 in another. Those numbers set this design: cost per delivered requirement in dollars (not tokens) as the top metric, repetitions with a noise band as the only admissible comparison, and the product's new per-request ledger and request cap as instruments.

## Corpus

The ten open requirements the `spike-leitura-teto` campaign wrote against fork `a1117f7` and froze (`spike/corpus/requisitos.jsonl`, key hash in `spike/corpus/gabarito.json`): each has a write scope, a hand-made list of relevant files, and an acceptance proof under `spike/corpus/provas/` that was verified to fail at the fork and to pass when the requirement is met. Reused unchanged because a corpus another campaign froze cannot have been tuned to favour an arm of this one, and because every proof already passed in that campaign's control arm, so the work is known to be doable by the writer.

Every run of every arm starts from the same commit: the fork plus one commit adding the proofs. All three arms see the same requirement text, the same write scope, the same relevant files and the same proof command; arm A gets them as a packet per node, B and C as one prompt.

## Metrics

| metric | definition | direction |
| --- | --- | --- |
| `costPerDeliveredRequirementUsd` | provider-reported cost of the run divided by the proofs that pass afterwards; null when none pass | down |
| `costUsd` | arm A: the run's `usage.jsonl`, workers and judges, priced by the product; B and C: the session's `total_cost_usd` | down |
| `proofsPassed` | proofs passing on the final tree, run by the driver with the proofs restored from the corpus | up |
| `wallClockMinutes` | from launch to the last provider exit | down |
| `requests` | provider requests, from the product's per-request session ledger | down |
| `contextMaxKTokens` | the largest context any request of the run re-sent | down |
| `outOfScopeFiles` | files changed outside the union of the corpus write scopes | down |

`costPerDeliveredRequirementUsd` is the top metric. A cheap run that delivers nothing is not economy.

## Design

- **Interleaving.** Within one repetition the three arms run back to back in a seeded shuffled order, so a provider that drifts over the day drifts across arms rather than between them (the first spike ran one arm two hours later and measured the clock instead of the treatment).
- **Repetitions and the band.** Arm A is the control and is repeated; its spread across repetitions is the noise band, computed with `evals/run.mjs --band`, and every comparison is judged against it with `--compare --band`. A delta inside the band is reported as "not measured", never as "no difference".
- **Phases and budget.** *Smoke*: one requirement, one repetition, all arms, to prove the pipeline end to end. *Pilot*: five requirements, three repetitions per arm (extended from one when the first came in at a fifth of the cap), to size cost and time and to obtain a first band. *Full*: the ten requirements, two repetitions per arm and four arms, launched under the owner's standing instruction to measure this now and inside the same US$ 40 envelope (pilot spend US$ 13, full round projected at US$ 20 from pilot rates); a third repetition is a separate decision. Spend is recorded per run in the ledger.
- **What is deliberately asymmetric.** Arm A has a judge, a write-scope boundary, a request cap of 150 per node and parallel nodes; B and C have none of that and a cap of 1000 requests for the whole session. Those are the product's mechanics and the thing under test; the comparison charges arm A the judge's cost and reports the others' out-of-scope edits.

## Hypotheses

| # | hypothesis | comparison | minimum detectable |
| --- | --- | --- | --- |
| H1 | faberun delivers a requirement for less: `costPerDeliveredRequirementUsd` A below B | A→B | outside the band |
| H2 | faberun delivers a requirement for less than native delegation: A below C | A→C | outside the band |
| H3 | faberun delivers at least as many proofs as either session arm | A→B, A→C | not lower, per run |
| H4 | faberun finishes the corpus in less wall clock than B (parallel nodes against one context) | A→B | outside the band |
| H5 | the session arms change files outside the write scopes and faberun does not | all | count |
| H6 | every effect claimed above is larger than arm A's own noise band | all | direct |

H6 is the honesty hypothesis and it decides what the report may say.

## Kill criteria

Discard the premise, without a second attempt, if H3 fails in the full round: faberun delivers fewer proofs than a single session on the same corpus. Report "not measured" and stop, if the full round's effects all sit inside the band: the answer is more repetitions or a harder corpus, not another hypothesis. Abort the pilot and report if a session arm cannot complete the corpus at all (a cap or a crash) — that is a finding about the arm, not noise.

## Requirements

### R1. The three arms run the same corpus from the same commit

- **statement:** every run of every arm starts from fork `a1117f7` plus the proofs commit, and the requirement text, write scope, relevant files and proof command an arm receives are identical across arms; B and C differ from each other only by the delegation paragraph.
- **proof:** `command: node --test spike/arms/test/arms.test.mjs`

### R2. Every run is measured the same way

- **statement:** the driver runs the proofs itself on the final tree with the proofs restored, audits changed files against the union of write scopes, and records cost, requests, context and wall clock in one ledger line per run with the corpus hash and the fork.
- **proof:** `path: spike/arms/resultados/runs.jsonl`

### R3. A comparison is a delta against a band, never a bare number

- **statement:** the analysis computes arm A's noise band from its repetitions with the product's evals machinery and reports each pairwise comparison as significant or "not measured".
- **proof:** `path: spike/arms/resultados/analysis-pilot.md`

### R4. The pipeline is proven before budget is spent

- **statement:** the smoke phase completes one requirement through all three arms, with a contract that validates, a session that returns a result event, and proofs that run.
- **proof:** `path: spike/arms/resultados/analysis-smoke.md`

## Non-goals

- Any change to `src/`, `test/`, `evals/` or `bin/`: the campaign lives in `spike/arms/` and this record.
- A different writer per arm. The writer is the same model in every arm; a comparison across models is another campaign.
- Judging code quality beyond the proofs in the smoke and pilot. An independent cross-vendor judge over every arm's diff is planned for the full round and its cost is measurement cost, not arm cost.
- Concluding anything from the pilot alone. The pilot sizes the full round; only the full round may confirm or discard a hypothesis.

## Constraints

- The corpus and its proofs are never edited by an arm; a run that edits a proof is measured against the restored proof and the edit is recorded.
- Arm A runs under its own `FABERUN_HOME` so the experiment never touches the user's projects, and no arm can reach the notification transport.
- Arms run sequentially, never in parallel with each other: the machine's memory and the provider's quota are shared confounders.

## Success criteria

The pilot yields one ledger line per arm with all seven metrics, a validated contract per arm-A run, a stream log per session run, and an analysis that names what is and is not measured. The full round, if launched, answers H1 to H6 with the band.

## Risks

- **Subagent spend.** Whether a claude session's `total_cost_usd` includes its subagents' calls is unverified; the driver records the session meter's per-request sum beside it so a gap is visible, and the smoke checks it.
- **A session that never ends.** The 1000-request cap ends it; the run is then recorded with what it delivered.
- **Memory on the host.** A live campaign was running its own verification while this was built; arms run one at a time and arm A's `maxParallel` is 3.
