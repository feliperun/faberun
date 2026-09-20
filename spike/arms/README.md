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
| D | arm A with `gate: false`: the proof is the only gate, no judge | same as A |
| E | arm D with the writer swapped for DeepSeek Flash through dsh (`DEEPSEEK_RUNTIME`), no fallback | same as A; dsh reports no cost, so the product prices the counters from the vendored models.dev seed |

Two corpora, one shape (`corpus.mjs`). `simple`: the ten frozen requirements
of `spike/corpus/`, independent, each with a visible proof; every run starts
from fork `a1117f7` plus one commit with the proofs. `complex`: the four
dependent nodes of the real phase `1c-run-path-resolver`
(`spike/corpus-complex/nodes.json`, base `4913ef2`, `npm ci` in the checkout),
with a hidden acceptance: the landed `test/run/paths.test.mjs` restored from
`054dd4c`, the centralization check in `checks/centralization.mjs`, typecheck
and the run/repo/cli/campaign suites. Afterwards the driver restores the
acceptance files (`fork.mjs`), runs the acceptance itself, audits changed files
against the union of write scopes, and keeps the final tree under
`refs/arms/<label>/<arm>-r<n>`.

## Run

```bash
node spike/arms/measure.mjs --corpus simple --label pilot --requirements CONTRACT,HOST,NOTIFY,REPO,RUN --arms A,B,C,D --repetitions 3
node spike/arms/measure.mjs --corpus simple --label full --requirements all --arms A,B,C,D --repetitions 2
node spike/arms/measure.mjs --corpus complex --label complex --arms A,B,C,D,E --repetitions 2
node spike/arms/analyse.mjs --label complex
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
