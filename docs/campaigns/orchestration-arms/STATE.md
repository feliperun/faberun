# orchestration-arms · state

Updated: 2026-09-20. Spec: `spec/SPEC.md` (1.1.0). Driver: `spike/arms/`. Ledger: `spike/arms/resultados/runs.jsonl`. Analyses: `spike/arms/resultados/analysis-pilot.md`, `analysis-full.md`.

## Where it stands

Smoke, pilot and full round done. Spend: smoke US$ 1.0, pilot US$ 12.0, full round US$ 26.6, total US$ 39.6 against the US$ 40 envelope (the full round came in at 26.6 rather than the 20 projected, because arm A with its judge scaled to twice the pilot's cost per requirement rather than proportionally).

## Full round: ten requirements, four arms, two repetitions

Corpus: the whole frozen ten at fork `a1117f7` plus the proofs commit. Writer `claude-sonnet-5` in every arm; arm A's judge `gpt-5.6-sol` through codex; arm D is arm A with `gate: false`, the proof as the only gate. Arms interleaved per repetition in a seeded order.

| arm | proofs | cost USD | USD per delivered requirement | wall clock min | requests | max context k tokens | out of scope |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A faberun, judge | 10/10, 10/10 | 5.02 · 4.80 | 0.49 | 7.0 | 203 | 82 | 0 |
| B one session | 10/10, 10/10 | 3.09 · 2.61 | 0.28 | 8.9 | 172 | 157 | 0 |
| C session with subagents | 10/10, 10/10 | 2.48 · 3.20 | 0.28 | 6.1 | 282 | 81 | 0 |
| D faberun, proof-only gate | 10/10, 10/10 | 2.63 · 2.74 | 0.27 | 4.5 | 209 | 83 | 0 |

Medians. Arm A's band across its two repetitions: cost ±0.11, cost per delivered ±0.01, wall clock ±0.23 min, requests ±6, max context ±0.7k. Two repetitions make a thin band; every claim below names it.

Arm A's cost splits into worker 2.69 and judge 2.22: the judge is 45% of the run. All 30 arm-A and arm-D nodes settled on attempt 1 with no revision; the judge passed every node it saw and asked for nothing.

## Hypotheses against the band

| # | hypothesis | pilot (5 req, n=3) | full round (10 req, n=2) |
| --- | --- | --- | --- |
| H1 | faberun cheaper per delivered requirement than one session | refuted, +69% | **A refuted, +74%; D holds marginally, −6% (0.27 against 0.28, outside a ±0.01 band)** |
| H2 | faberun cheaper than native subagents | refuted, +46% | **A refuted, +73%; D holds marginally, −6%** |
| H3 | faberun delivers at least as many proofs | tie | **tie: 10/10 in every run of every arm** |
| H4 | faberun finishes in less wall clock than one session | held, −16% | **held: A −22%, D −50% (4.5 against 8.9 min); D also −27% against C** |
| H5 | session arms edit outside the write scopes | not supported | **not supported: zero out-of-scope files in all 8 runs** |
| H6 | claimed effects exceed the band | yes | yes; the D−B and D−C cost deltas sit just outside a two-reading band and are reported as marginal |

## Verdict

On this corpus -- ten small, independent requirements, each with a mechanical proof, the same model everywhere -- **the orchestration itself is as cheap as one session and twice as fast**, and **the judge, as arm A configured it, doubles the cost and bought nothing**.

- Faberun without the judge (D) delivered every proof at US$ 0.27 per requirement against 0.28 for one session and 0.28 for a session with subagents: a 6% edge that a two-reading band barely resolves, so call it parity. It finished the corpus in 4.5 minutes against 8.9 for one session and 6.1 for subagents: half the single session's wall clock, a difference twenty times the band.
- Faberun with the judge (A) cost 74% more than one session per delivered requirement and 73% more than subagents, and 83% more than its own judge-less twin. In 30 nodes the judge found nothing: every node passed on attempt one. Where a proof is mechanical, the judge is a tax on this corpus.
- Quality tied everywhere: 80 proofs of 80, no file changed outside a write scope in any arm. The scope boundary faberun enforces was never tested by these sessions, which stayed inside it unprompted.
- The single session's context reached 157k tokens against 81-83k for every other arm, and it was the slowest arm; its cost stayed within 6% of the others here, but the mechanism that raises cost with context re-read per request is the one thing in this corpus that grows with the corpus.

So: **better and more efficient than one session or than subagents?** As an execution engine with the proof as its gate, faberun matched them on cost and beat them on time, with the enforcement guarantees the sessions happened not to need. As configured with a blocking judge on proof-backed nodes, it was the most expensive arm by a wide margin. The honest product claim this measurement supports is "the same cost, half the time, with the scope and proof enforced", not "cheaper".

## What this does not measure

Requirements without a mechanical proof, where a judge is the only gate; dependent nodes, where one session's accumulated context is an asset rather than a liability; and failures that need retry and attribution, which faberun structures and a session improvises. Those are the conditions the product was built for and the next corpus has to contain them, with a third repetition per arm so the band stops being two readings.

## Consequences for the product

- A judgment item on a node that already has a mechanical proof should be the exception, not the template: 45% of arm A's spend, 0 findings. `faberun plan` and contract authoring should default proof-backed nodes to `gate: false` or an advisory review.
- The wall-clock advantage comes from `maxParallel` 3 with independent nodes; the pilot's 5-requirement runs showed it too. It is the product's clearest measured win.
- Arm C's requests varied 254 to 309 and its wall clock 4.1 to 8.1 minutes between two repetitions; native delegation is the noisiest arm.

## Fixed while building

- A run needs its campaign registered in its checkout's project; the driver registers one per faberun checkout under the experiment home.
- A Definition of Done command proof carries the command itself, not an index into verification.
- Scope closure names test importers of the write files; the driver acknowledges them mechanically and records what it acknowledged (five per ten-node run).
- A refused launch leaves a run directory behind and a reused id is refused; each attempt gets a unique id.

## Instruments the campaign leaned on

The per-request session ledger, the `maxTurns` cap, the rotate-by-default session policy and the `--band`/`--compare --band` evals commands all come from the `cost-and-cache-economics` branch this campaign is stacked on.
