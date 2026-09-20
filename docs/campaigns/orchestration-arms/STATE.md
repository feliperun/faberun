# orchestration-arms · state

Updated: 2026-09-20. Spec: `spec/SPEC.md`. Driver: `spike/arms/`. Ledger: `spike/arms/resultados/runs.jsonl`. Analysis: `spike/arms/resultados/analysis-pilot.md`.

## Where it stands

Smoke and pilot done; full round not launched. Spend so far: smoke US$ 0.9, pilot US$ 12.0, of the US$ 40 cap for both.

## Pilot: five requirements, three repetitions per arm

Corpus: CONTRACT, HOST, NOTIFY, REPO, RUN from the frozen ten, fork `a1117f7` plus the proofs commit. Writer `claude-sonnet-5` in every arm; arm A's judge `gpt-5.6-sol` through codex. Arms interleaved per repetition in a seeded order.

| arm | proofs | cost USD | USD per delivered requirement | wall clock min | requests | max context k tokens | out of scope |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A faberun | 5/5, 5/5, 5/5 | 1.85 · 1.76 · 1.69 | 0.35 | 3.4 | 82 | 50 | 0 |
| B one session | 5/5, 5/5, 5/5 | 1.04 · 0.88 · 1.10 | 0.21 | 4.0 | 75 | 104 | 0 |
| C session with subagents | 5/5, 5/5, 5/5 | 1.20 · 1.01 · 1.45 | 0.24 | 3.1 | 117 | 50 | 0 |

Medians. Arm A's noise band across its three repetitions: cost ±0.08 USD, cost per delivered ±0.02, wall clock ±0.04 min, requests ±6.5, max context ±5.3k. Every delta below is judged against it.

Arm A's cost splits into worker 1.05 and judge 0.75 (medians): the judge is 42% of the run. Arm A's worker-only cost equals arm B's whole cost.

## Hypotheses against the band

| # | hypothesis | result on this corpus |
| --- | --- | --- |
| H1 | faberun cheaper per delivered requirement than one session | **refuted**: 0.35 against 0.21, +69%, outside the band |
| H2 | faberun cheaper than native subagents | **refuted**: 0.35 against 0.24, +46%, outside the band |
| H3 | faberun delivers at least as many proofs | **tie**: 5/5 in every run of every arm |
| H4 | faberun finishes in less wall clock than one session | **held against B**: 3.4 against 4.0 min, outside the band; C was faster still (3.1) |
| H5 | session arms edit outside the write scopes and faberun does not | **not supported**: zero out-of-scope files in all nine runs |
| H6 | claimed effects exceed the band | yes: every stated difference is outside arm A's band; ties are reported as not measured |

## Verdict, and what it does not say

On this corpus -- five small, independent requirements, each with a mechanical proof, the same model everywhere -- faberun did not deliver more per dollar than one session or than one session delegating to subagents. It delivered the same (every proof, no collateral edit) at a 46-69% premium, and the premium is the judge: without it, faberun's execution cost is the single session's. It finished 16% faster than the single session because its nodes ran three at a time, and slower than the subagent session, which parallelised the same way with less overhead.

What the pilot does not exercise is where the product's mechanics are supposed to pay: a corpus long enough for one session's context to keep growing (arm B already ended at 104k tokens of context against 50k for A and C after five requirements, and the stored runs show cost tracks context re-read per request), requirements without a mechanical proof where a judge is the only gate, dependent nodes, and failures that need retry and attribution. The full round (ten requirements, three repetitions, about US$ 25 at pilot rates) tests the first of those; a harder corpus tests the rest.

The kill criterion in the spec is H3 failing in the full round; H3 did not fail. The cost hypotheses failed in the pilot, and the honest reading is that the campaign has refuted the premise for small, well-specified, proof-backed work, and has not yet measured it for the work faberun was built for.

## Fixed while building

- A run needs its campaign registered in its checkout's project; the driver registers one per arm-A checkout under the experiment home.
- A Definition of Done command proof carries the command itself, not an index into verification.
- Scope closure names test importers of the write files; the driver acknowledges them mechanically and records what it acknowledged (three per run here).
- A refused launch leaves a run directory behind and a reused id is refused; each attempt gets a unique id.

## Instruments the campaign leaned on

The per-request session ledger, the `maxTurns` cap, the rotate-by-default session policy and the `--band`/`--compare --band` evals commands all come from the `cost-and-cache-economics` branch this campaign is stacked on.
