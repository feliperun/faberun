---
id: orchestration-arms
title: "Does orchestrating with faberun beat one session, or one session with its own subagents?"
version: 1.5.0
status: draft
date: 2026-09-20
owner: Felipe Broering
target: feliperun/faberun
baseline: a1117f7 (simple corpus), 4913ef2 (complex corpus)
---

# Does orchestrating with faberun beat one session, or one session with its own subagents?

## Intent

Faberun's premise is that a closed packet per node, a fresh session per attempt, a mechanical proof and an independent judge deliver more per dollar and per hour than one agent doing everything in one context. That premise has never been measured against the two obvious alternatives an operator has at hand: give the whole job to one session of the same model, or give it to one session that delegates to the harness's own subagents. This campaign measures all three on the same work, the same model, the same base commit, with repetitions and a noise band, and reports a result only where the difference is larger than the noise.

The question is stated as three arms and two comparisons:

- **Arm A, faberun.** One contract with one node per requirement, the product's closed execution packet, the write scope enforced at the tool boundary, the requirement's proof as the node's verification, a blocking cross-vendor judge with one revision, `maxParallel` 3 and the product's attempt bounds (150 requests, wall clock, stall).
- **Arm B, single session.** One `claude -p` session, the same model and permission mode as arm A's workers, the same built-in tools, given every requirement at once with the same text, write scope, relevant files and proof command a faberun node gets, and told to run the proofs.
- **Arm C, session with subagents.** Arm B plus the Agent tool and one paragraph telling it to delegate each requirement to a subagent, run independent ones in parallel and integrate.
- **Arm D, faberun with the proof as the only gate.** Added after the pilot (version 1.1.0): arm A without the judge, `gate: false`, the configuration the product documents for a fully mechanical node. The pilot measured the judge at 42% of arm A's cost and arm A's worker-only cost equal to one session's whole cost, so the orchestration and the judge have to be measured apart to say which one the premium belongs to.

- **Arm E, faberun with a cheaper writer.** Added with the complex round (version 1.3.0), at the owner's request: arm D with the worker swapped for DeepSeek Flash through the dsh harness, no fallback, the same packets, the same proof-only gate. The owner's hypothesis is that a writer whose list price is 13x lower on input and 17x lower on output than the frontier models (deepseek-flash 0.15 / 0.003 / 0.60 USD per MTok against claude-sonnet-5 2 / 0.2 / 10 and gpt-5.6-sol 4 / 0.4 / 20) delivers the corpus for less in total even if it spends more tokens and more attempts getting there, so that depending only on Claude or Codex is the expensive choice. dsh reports no cost; the product prices its token counts from the vendored models.dev seed, the same rates the CLI-reported Claude cost is built from.

- **The proof-only gate has one revision (version 1.5.0).** On the complex corpus arms D to J run with `gate: { review: "none", maxRevisions: 1 }` rather than `gate: false`. Measured 2026-09-20 on arm E's first run: with the gate disabled a red deterministic verification ends the node with no second attempt (the revision path lives behind `gate.enabled`), while arm A's blocking judge grants one, and a session arm simply reads the failing test and fixes it. `review: "none"` dispatches no judge and keeps the revision, so every faberun arm has the same budget of one fresh attempt after a red verification and the only difference between A and D is the judge. In the simple round `gate: false` and this gate are indistinguishable: no verification went red there. Recorded as a product finding too: the configuration the product documents for a mechanical node retries nothing.
- **A timing test in the corpus's own verification.** The same run showed why the budget matters: `test/run/process.test.mjs:341` at the base asserts that a provider "must have written its one line by now", an upper bound on a duration, the class of test this repository's own rules forbid, and it failed once under three concurrent workers and a typecheck while passing on an idle machine (0 failures in 6 runs of the file, measured right after). It stays in the corpus: it was in the real phase's verification, a real campaign faced the same risk, and with one revision a flake costs an attempt rather than the node. The driver's acceptance runs the suites alone on an idle machine.
- **Arms F to J, faberun with other writers.** Added the same evening (version 1.4.0), again at the owner's request: arm D with the writer swapped, one model per arm across four harnesses, no fallback, the same packets and the same proof-only gate. F claude-opus-5 through claude (5 / 0.5 / 25), G gpt-5.6-sol through codex (4 / 0.4 / 20), H gpt-5.6-luna through codex (0.2 / 0.02 / 1.2), I gpt-6-astra through codex (10 / 1 / 50, the OpenAI list price read from models.dev on 2026-09-20 and declared on the runtime because the vendored seed predates the model), J glm-5.3-flash through zcode (0.15 / 0.03 / 0.5). The owner asked for "GLM 5.5 Flash"; no such model exists in models.dev, the product's catalogue or this machine's ZCode history, so the newest flash stands in and the substitution is recorded here. Together with E the writer arms span a 67x range of output price, from luna and deepseek at the bottom to astra at the top, under one orchestration.

Comparison 1 is A against B; comparison 2 is A against C. B against C is reported because it falls out for free and says whether native delegation is the cheaper half of orchestration. D against B and D against C say what the orchestration costs without the judge. Each writer arm (E to J) is compared against D, the same orchestration with the sonnet writer, which is the writer question with everything else held equal; and against A and B, which say whether that writer beats the judged configuration and the single session.

## Estado medido

Before any arm ran, the stored runs under the user's faberun home were measured (2026-09-20): a claude worker turn makes a median of 49 provider requests and re-reads a context that grows 1.9x within the turn; 98-99% of that context is served from cache in every harness; a turn opened on a phase sibling's session cost 1.87x a fresh one; the 23 turns that produced nothing held 25% of all context spend. The same packet on the same model varied by a factor of 3.3 across 10 repetitions in one earlier campaign and 2.12 across 2 in another. Those numbers set this design: cost per delivered requirement in dollars (not tokens) as the top metric, repetitions with a noise band as the only admissible comparison, and the product's new per-request ledger and request cap as instruments.

## Corpus

The ten open requirements the `spike-leitura-teto` campaign wrote against fork `a1117f7` and froze (`spike/corpus/requisitos.jsonl`, key hash in `spike/corpus/gabarito.json`): each has a write scope, a hand-made list of relevant files, and an acceptance proof under `spike/corpus/provas/` that was verified to fail at the fork and to pass when the requirement is met. Reused unchanged because a corpus another campaign froze cannot have been tuned to favour an arm of this one, and because every proof already passed in that campaign's control arm, so the work is known to be doable by the writer.

Every run of every arm starts from the same commit: the fork plus one commit adding the proofs. All three arms see the same requirement text, the same write scope, the same relevant files and the same proof command; arm A gets them as a packet per node, B and C as one prompt.

**Complex corpus (version 1.2.0).** The full round on the ten independent requirements answered the cost question but not the one the product exists for: work whose parts depend on one another and cross the repository. The owner's instruction was that small campaigns do not make sense as the test, so the second corpus is a real phase of a real campaign, `1c-run-path-resolver` of `state-location-and-routing-economics`, exactly as it was executed on 2026-09-18 against base `4913ef2`: four nodes (`spike/corpus-complex/nodes.json`, extracted from the recorded contract), a resolver module whose exports three other nodes consume, two migration nodes that depend on it and together rewrite 26 files of `src/`, and a ratchet node that depends on both. The arms receive the recorded packets word for word -- objective, instructions, symbols, decisions, non-goals, read and write files -- plus one line in the resolver node naming the seven exports the landed acceptance test imports, so no arm fails for a naming choice. Per-node verification is trimmed from the recorded whole-directory suites to what proves each node (the recorded `test/engine/` alone runs 19 minutes).

The acceptance is hidden from the arms and run by the driver on the final tree: the test the phase actually landed (`test/run/paths.test.mjs` at `054dd4c`, restored over whatever the arm wrote), a centralization check that measures what the landed ratchet measures (only `src/run/paths.mjs` spells the double-quoted runs literal in `src/`; 21 files do at the base), the repository typecheck, and the regression suites the phase verified against (`test/run/`, `test/repo/`, `test/cli/`, `test/campaign/`, 307 tests, about 3 minutes). Both were verified to fail at the base and pass at the landing. Historical reference for the same work: the real run cost US$ 7 of worker, took 68 minutes, and its resolver node needed two attempts.

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
- **Phases and budget.** *Smoke*: one requirement, one repetition, all arms, to prove the pipeline end to end. *Pilot*: five requirements, three repetitions per arm (extended from one when the first came in at a fifth of the cap), to size cost and time and to obtain a first band. *Full*: the ten requirements, two repetitions per arm and four arms, launched under the owner's standing instruction to measure this now and inside the same US$ 40 envelope (pilot spend US$ 13, full round projected at US$ 20 from pilot rates); a third repetition is a separate decision. *Complex* (version 1.2.0): the four-node phase, four arms, two repetitions, under a separate US$ 60 envelope (about US$ 30 per repetition from the historical run's worker cost plus the judge's share measured in the full round), the first repetition launched on 2026-09-20 with the second to follow unless the owner says otherwise. With arms E to J (versions 1.3.0 and 1.4.0) the first repetition is ten arms and the envelope for it is US$ 130: the six writer arms scale the historical US$ 7 sonnet worker cost by their price ratio (deepseek, luna and glm under US$ 1 each; sol about US$ 14; opus about US$ 18; astra about US$ 35). The second repetition is a decision the owner takes on the first's report, not a default. Spend is recorded per run in the ledger.
- **Delivered, on the complex corpus.** The denominator of the top metric is the acceptance checks that pass (four per run), not requirements: a migration that leaves one call site behind fails centralization and typecheck together, and counting it as three quarters delivered would be generous to every arm alike. The session arms are told the acceptance commands, not given the acceptance files.
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
| H7 | a cheaper writer delivers for less in total: `costPerDeliveredRequirementUsd` of E, H and J below D, and below A and B, even with more tokens and attempts | E→D, H→D, J→D, and each →A, →B | outside the band, and the arm delivers at least as many acceptance checks as D |
| H8 | a pricier frontier writer does not deliver more per dollar: `costPerDeliveredRequirementUsd` of F, G and I is not below D | F→D, G→D, I→D | outside the band |

H6 is the honesty hypothesis and it decides what the report may say.

On the complex corpus the same six are re-tested, plus H7, with `proofsPassed` read as acceptance checks passed, and H4 is the one the corpus was chosen for: two of the four nodes are independent of each other and the product runs them in parallel while a session does them in sequence, so if orchestration has a wall-clock advantage on dependent work this is where it shows. H5 gains teeth too: 26 files of write scope across `src/` is where a session drifts.

## Kill criteria

Discard the premise, without a second attempt, if H3 fails in the full round: faberun delivers fewer proofs than a single session on the same corpus. H7 is refuted for a writer, whatever its price, if its arm delivers fewer acceptance checks than arm D: a cheaper writer that does not finish the work has no cost per delivered requirement to compare. A writer arm that dies on a provider quota or a subscription limit is not measured and is rerun, not counted. Report "not measured" and stop, if the full round's effects all sit inside the band: the answer is more repetitions or a harder corpus, not another hypothesis. Abort the pilot and report if a session arm cannot complete the corpus at all (a cap or a crash) — that is a finding about the arm, not noise.

## Requirements

### R1. The three arms run the same corpus from the same commit

- **statement:** every run of every arm starts from the corpus fork (`a1117f7` plus the proofs commit for the simple corpus, `4913ef2` plus `npm ci` for the complex one), and the requirement text, write scope, relevant files and verification an arm receives are identical across arms; B and C differ from each other only by the delegation paragraph.
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

- The corpus and its proofs are never edited by an arm; a run that edits a proof is measured against the restored proof and the edit is recorded. On the complex corpus the acceptance files are not in the tree an arm works on at all: the landed test is restored over the arm's tree afterwards, and the centralization check lives in the driver.
- Arm A runs under its own `FABERUN_HOME` so the experiment never touches the user's projects, and no arm can reach the notification transport.
- Arms run sequentially, never in parallel with each other: the machine's memory and the provider's quota are shared confounders.

## Success criteria

The pilot yields one ledger line per arm with all seven metrics, a validated contract per arm-A run, a stream log per session run, and an analysis that names what is and is not measured. The full round, if launched, answers H1 to H6 with the band.

## Risks

- **Subagent spend.** Whether a claude session's `total_cost_usd` includes its subagents' calls is unverified; the driver records the session meter's per-request sum beside it so a gap is visible, and the smoke checks it.
- **A session that never ends.** The 1000-request cap ends it; the run is then recorded with what it delivered.
- **Memory on the host.** A live campaign was running its own verification while this was built; arms run one at a time and arm A's `maxParallel` is 3.
- **The subscription's session limit.** Measured 2026-09-20 17:00 BRT: the first launch of the complex round hit the Claude subscription's session limit ("You've hit your session limit", reset 18:40) after the pilot and full round had consumed the window; arms B, D and A failed inside two minutes with nothing spent, arm C spent US$ 1.86 on a subagent before being cut. A run whose result is that message is not a measurement and is rerun after the reset; arm E does not share the limit.
- **The checkout's own hooks.** Measured the same day: a checkout with `npm ci` carries husky's commitlint and `npm run check`, which refused the driver's snapshot commits and lost the measurement of all four arms; the driver's bookkeeping commits now run with an empty hooks directory.
