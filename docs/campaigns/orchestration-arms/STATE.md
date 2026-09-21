# orchestration-arms · state

Updated: 2026-09-21. Spec: `spec/SPEC.md` (1.6.0). Driver: `spike/arms/`. Ledger: `spike/arms/resultados/runs.jsonl`. Analyses: `spike/arms/resultados/analysis-pilot.md`, `analysis-full.md`, `analysis-complex.md`.

## Where it stands

Simple corpus: smoke, pilot and full round done, US$ 39.6 against the US$ 40 envelope. Complex corpus: one repetition of ten arms done on 2026-09-20 (US$ 28.85 recorded including voided launches and smokes, plus an estimated US$ 1 to 2 from two launches killed mid-flight, against the US$ 130 envelope); a second repetition, which is what would turn the sonnet-arm readings into results and re-sample the astra refusal, awaits the owner's decision.

## Complex round: the recorded 1c phase, ten arms, one repetition

Corpus: phase `1c-run-path-resolver` of `state-location-and-routing-economics` as it was executed on 2026-09-18 against base `4913ef2`: four dependent nodes (a resolver, two migrations that depend on it and together rewrite 26 files of `src/`, a ratchet that depends on both), the recorded packets word for word plus one line naming the seven resolver exports the landed test imports. Acceptance hidden from the arms and run by the driver: two proofs (the landed `test/run/paths.test.mjs` from `054dd4c`, the centralization check) and two guards (typecheck, the run/repo/cli/campaign suites). A run delivers the proofs that pass while every guard passes. Historical reference: the real run cost US$ 7 of sonnet worker and took 68 minutes, with two attempts on the resolver node.

Ten arms, one repetition, seeded order E, D, G, H, I, C, J, F, B, A, run 2026-09-20 18:56 to 23:14 BRT. Writer `claude-sonnet-5` in A to D; arms E to J are D with the writer swapped. Arms D to J run with `gate: { review: "none", maxRevisions: 1 }`: no judge, one revision, the same revision budget arm A's blocking judge has.

| arm | what | delivered | cost USD | USD per proof | wall min | requests | ctx max k | out of scope | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | faberun sonnet, blocking codex judge | 2/2 | 4.45 | 2.23 | 23.0 | 336 | 103 | 0 | worker 3.37 + judge 1.08; 4 pass verdicts, 0 findings, 0 revisions |
| B | one sonnet session | 2/2 | 4.69 | 2.34 | 18.8 | 287 | 166 | 0 | 175 turns |
| C | sonnet session with subagents | 2/2 | 3.60 | 1.80 | 22.2 | 316 | 125 | 0 | 4 Agent calls |
| D | faberun sonnet, proof-only gate | 2/2 | 5.07 | 2.54 | 25.1 | 316 | 129 | 0 | 4 nodes on attempt 1 |
| E | faberun deepseek-flash (dsh) | 2/2 | 0.11 | 0.05 | 14.1 | 82 | 93 | 0 | 4 nodes on attempt 1 |
| F | faberun claude-opus-5 | 2/2 | 5.33 | 2.66 | 22.1 | 167 | 62 | 0 | 4 nodes on attempt 1 |
| G | faberun gpt-5.6-sol (codex) | 2/2 | 2.66 | 1.33 | 19.4 | — | — | 0 | 69 tool calls |
| H | faberun gpt-5.6-luna (codex) | 2/2 | 0.22 | 0.11 | 25.7 | — | — | 0 | 76 tool calls |
| I | faberun gpt-6-astra (codex) | 0/2 | 0.27 | — | 0.9 | — | — | 0 | writer refused the packet: `blocked_context` after 4 tool calls, no file changed |
| J | faberun glm-5.3-flash (zcode) | 2/2 | 0.16 | 0.08 | 36.6 | — | — | 0 | 4 nodes on attempt 1 |

Codex and zcode streams carry no per-request meter, so requests and context are not measured for G to J. Every delivering arm changed the same 29 files and none outside the write scopes. Full tables and every pairwise comparison: `spike/arms/resultados/analysis-complex.md`.

### Hypotheses, single reading

One repetition gives no band: arm A has one run, so nothing below is "measured" in the spec's sense, and the two faberun-sonnet runs of the round (A's worker at US$ 3.37 against D at 5.07, the same configuration but for the judge) say the band for sonnet arms would be wide, of the order of 40%. Readings that fall inside that spread are reported as unresolved; readings an order of magnitude outside it are reported as findings.

| # | hypothesis | reading | status |
| --- | --- | --- | --- |
| H1 | faberun cheaper per delivered proof than one session | A 2.23 against B 2.34 (−5%); D 2.54 against B 2.34 (+9%) | unresolved: inside the sonnet spread |
| H2 | faberun cheaper than native subagents | A 2.23 against C 1.80 (+24%); D 2.54 against C 1.80 (+41%) | unresolved, direction against faberun |
| H3 | faberun delivers at least as many proofs | 2/2 in A, B, C, D | tie |
| H4 | faberun finishes in less wall clock than one session | A 23.0 and D 25.1 against B 18.8 and C 22.2 | not held in this reading: faberun 4 to 6 minutes slower, the opposite of the simple round |
| H5 | session arms edit outside the write scopes | 0 out-of-scope files in all 10 runs | not supported, as in the simple round |
| H6 | claimed effects exceed the band | no band; the writer effects are 20 to 50 times the whole sonnet spread | only the writer effects are claimed |
| H7 | a cheaper writer delivers for less in total | E 0.05, J 0.08, H 0.11 per proof against D 2.54, A 2.23, B 2.34, C 1.80 | held: 16 to 50 times cheaper per proof, all 2/2, all in scope; E also the fastest arm of the round |
| H8 | a pricier frontier writer does not deliver more per dollar than sonnet | F 2.66 against D 2.54 (+5%); G 1.33 against D 2.54 (−48%); I undefined | held for opus (same cost, half the requests); refuted for sol in this reading (half the cost, a third of the tool calls); astra refused and delivered nothing |

### Verdict of the round

On a four-node dependent phase with the same model everywhere, **the way the work is organised did not move the bill**: one sonnet session, a session with subagents, faberun with the proof as gate and faberun with a judge landed between US$ 1.80 and 2.66 per delivered proof and between 19 and 25 minutes, all 2/2, all inside the write scopes, and one reading cannot rank them. The simple round's wall-clock advantage did not appear here: each faberun node opens a fresh session over the repository and runs two minutes of suites before it settles, and on a chain of dependent nodes that outweighs what running two nodes in parallel saves.

**The writer moved the bill by an order of magnitude, in the direction the owner predicted.** Under the same orchestration, DeepSeek Flash delivered the phase for US$ 0.11 in 14 minutes, GLM Flash for 0.16 in 37, Luna for 0.22 in 26, against 3.37 to 5.33 for sonnet or opus and 2.66 for sol. The cheap writers spent a third to a quarter of the requests sonnet spent and lost nothing on the proofs, the guards or the scope. Price per token is half the story; how many tokens a model needs to close the same packet is the other half, and here the two halves pointed the same way.

The judge cost 24% of arm A (US$ 1.08 for four passing verdicts with no finding), consistent with the simple round's 45% and zero findings: on proof-backed nodes it remains a tax in every reading so far.

So, to the owner's question: faberun did not make sonnet cheaper or faster than a sonnet session on this phase, and the honest claim stays what the simple round supported, the same cost with the scope and proof enforced; but faberun is what let a US$ 0.11 writer do the whole phase under enforced scope with mechanical proof, and that is where the money is. What this reading recommends is a second repetition of all ten arms (about US$ 27 of measured spend) so the sonnet arms get a band and the astra refusal gets a second sample, before any of the H1 to H4 readings is called a result.

### Consequences for the product, from this round

- **A red verification gets no retry without a gate.** With `gate: false` the revision path is unreachable; arm E's first run lost a node and its dependant to a single red check. `review: "none"` with `maxRevisions` works today and should be the documented mechanical-node default; better, `maxRevisions` should not depend on `gate.enabled` at all.
- **`test/run/process.test.mjs:341` bounds a duration from above** ("the provider must have written its one line by now") and failed under three concurrent workers while passing 6 of 6 idle runs. It breaks the repository's own rule and should be rewritten as a lower bound or an event wait.
- **Codex and zcode streams are not metered per request**; `requests` and `contextMax` are unknown for four of the ten arms. The session meter covers claude, dsh and agy only.
- **A writer may refuse a packet the others accept** (`blocked_context`), and the packet author cannot know which writer will. Arm I's writer named the file (`src/campaign/metrics.mjs`, a module-private `RUNS_DIR_NAME` it wanted to check before exporting the same name) and the reason; that file was node 2's write file, node 2 migrated it in every delivering tree, and the acceptance's `test/repo/` run holds the duplicate-export rule, so the risk it saw was real, belonged to another node and was covered. A defensible refusal, well diagnosed, not a packet defect. The recovery in a real campaign is the orchestrator's widen-and-resume; its cost was not measured here and should be.
- **The judge on proof-backed nodes**: 0 findings in 34 judged nodes across both rounds, 24 to 45% of the arm's cost. Corrected after review with the `state-location-and-routing-economics` session (2026-09-21): the product already dispatches no judge on a node whose Definition of Done carries no `judgment: true` item (`engine/judge-gate.mjs`); arm A paid a judge because this campaign's own contracts put a judgment item on every proof-backed node. The lever is the packet author's, not a product default, and the earlier recommendation to change the planner's gate is withdrawn.

### Fixed while building this round

- The driver's snapshot commits ran the checkout's husky hooks once `npm ci` was in the checkout, and commitlint refused them; bookkeeping commits now run with an empty hooks directory.
- The landed acceptance test was written over the arm's own before the regression suites ran and moved arm C's exact-count ratchet from 206 to 203; suites now run on the arm's tree and only the landed test runs after the restore. Arm C's acceptance was re-run on its own tree, its paths test recovered from the blob the first snapshot had staged.
- Guards that pass at the base counted as delivery; an arm that changed nothing scored 2 of 4. Checks now carry a kind and delivery is proofs passed while every guard passes.
- The first launch hit the Claude subscription's session limit (17:00 BRT, reset 18:40) and was voided; arms B, D and A spent nothing, arm C US$ 1.86.

Spend of the round: US$ 26.55 in the ten measured lines; US$ 1.95 voided and recorded (arm C of the aborted first launch, 1.86; the superseded first E line, 0.09), plus two D launches killed mid-flight by driver fixes whose workers' spend never reached a usage ledger, estimated at US$ 1 to 2; US$ 0.35 in smokes of the new writers. Total recorded US$ 28.85 against the US$ 130 envelope declared for a ten-arm repetition.


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
