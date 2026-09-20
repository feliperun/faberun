# orchestration-arms

The driver of the `orchestration-arms` campaign: does faberun deliver more per
dollar and per hour than one session of the same model, or than one session
using the harness's own subagents? Spec and rationale:
`docs/campaigns/orchestration-arms/spec/SPEC.md`.

## Arms

| arm | what runs | how it is measured |
| --- | --- | --- |
| A | `faberun run` on a contract with one node per requirement (`contract.mjs`), blocking codex judge, `maxParallel` 3, under `spike/.runs/home` | the run's `usage.jsonl` (priced by the product, workers and judges), its per-request session ledgers, the tree at `refs/faberun/<run>/run` |
| B | one `claude -p` session given the whole corpus (`prompt.mjs`) | the CLI's `total_cost_usd`, the product's session meter over the same stream |
| C | arm B plus the `Agent` tool and the delegation paragraph | same as B, plus the count of `Agent` calls |

Every run starts from fork `a1117f7` plus one commit with the corpus proofs
(`fork.mjs`). Afterwards the driver restores the proofs from `spike/corpus/`,
runs them itself, audits changed files against the union of write scopes, and
keeps the final tree under `refs/arms/<label>/<arm>-r<n>`.

## Run

```bash
node spike/arms/measure.mjs --label smoke --requirements CONTRACT --arms A,B,C --repetitions 1
node spike/arms/measure.mjs --label pilot --requirements CONTRACT,HOST,NOTIFY,REPO,RUN --arms A,B,C --repetitions 1
node spike/arms/measure.mjs --label full --requirements all --arms A,B,C --repetitions 3
node spike/arms/analyse.mjs --label pilot
node --test spike/arms/test/arms.test.mjs
```

Arms run sequentially, in a seeded shuffled order per repetition. A
`(label, arm, repetition)` already in the ledger is skipped, so an interrupted
measurement resumes; `--force` reruns it and the analysis takes every measured
line. Provider streams and faberun output go to `spike/.runs/arms-logs/`;
the ledger (`resultados/runs.jsonl`), the contracts, the indicator reports and
`analysis-<label>.md` are committed.

## Reading the analysis

`analysis-<label>.md` has one row per run, the arm medians, the noise band from
arm A's repetitions (half the range, per indicator) and each pairwise comparison
rendered by `evals/metrics.mjs`: a delta inside the band prints as "not
measured". `costPerDeliveredRequirementUsd` is the top metric; it is null for a
run that delivered nothing, because a cheap run that delivers nothing is not
economy.
