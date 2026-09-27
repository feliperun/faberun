# Retrospective: `planner-and-routing` (campaign 3a)

Closed 2026-09-27. Gate: the phase-one plan of `safe-to-hand-to-a-friend`
freezes with no hand edit. It did, on the tenth launch, at 2026-09-26 15:31
UTC (`plans/phase-1/contract.json`, rounds 3 and 4 with no critical finding).

## What landed

| requirement | what | commits |
| --- | --- | --- |
| R9 | `plan --resolve` resumes a contested plan from the operator's answers | `bffb268` |
| R14 | a revise that does not converge stops; see below for how it got there | `e815002`, `368c6a5`, `efd49bd`, `8a3ad2b`, `f61a13e` |
| R15 | an unwritable proof is found before review, without a model | `f8433c0` |
| R16 | a declared human step freezes as its own node and its dependants wait | `7f0d9f1`, `cd14f08` |
| R17 | the managed `AGENTS.md` block alone never blocks a launch | `2905b82`, `f3d0d81` |
| R18 | the judge comes from an ordered list per node | `68eb380`, `c465bdc` |
| R19 | the planner has reviewers of its own (`--reviewers`) | `09e57e8` |
| R20 | same-vendor review, opt-in in the contract | `de88732`, `f2c5c48` |
| R21 | `proof.ref` accepted as text or index | `fd6e134` |

`campaign close` reads R9 as open (8 of 9 carried by a done node): R9's
node exhausted and its work landed from the salvaged patch (`bffb268`), outside
any node. The close is right to say so; the code is on the branch.

Also landed while running: `faberun prune` (`615ae19`), a re-plan that skips
stage ids an earlier plan left (`1739f39`), a monthly spend limit read as
exhaustion (`2bf4444`), an under-measured verification timeout raised instead
of contested (`1938db7`).

## The gate took ten launches

The planner was 0 for 13 when this campaign opened. Every contested launch of
the gate plan was the planner's own defect, not the spec's:

1. Four launches died in bootstrap: the managed block counted as dirt, a stage id collided
   with the earlier plan's, and Fable hit its monthly spend limit.
2. R14 counted the round whose draft never validated as a baseline, and read
   the first real review as a regression.
3. R14 compared counts only: a revise that answered both round-1 criticals was
   stopped because round 2's review found two different ones.
4. **The revise never read the plan it revised.** Its packet carried the spec,
   repo facts, catalogue and findings, so every "revise" was a fresh draft:
   renamed files, dropped writes, and a retry that fixed one validator error
   while adding another. It is the likeliest single cause of the planner's 0 for
   13, though no earlier plan was re-run to confirm it.
5. With the revise fixed, four rounds ran with no critical from review; the
   plan contested on a 120 s timeout against a measured 84.4 s.
6. Four more rounds, still no critical from review, each contested on a
   scope-closure gap the previous revise had opened: the freeze pre-flight ran
   only after the next review.
7. The tenth froze, with the Claude quota exhausted, on DeepSeek drafting and GLM judging.

What to take from it: a pipeline whose stages cannot see each other's output
will look like a model problem. The check that finally mattered was reading a
stage's own packet (`readFiles`) against what its objective assumes it has.

## Spend

US$ 90.92 in runs (Sonnet 83.87, Opus 7.05) and US$ 32.23 in gate plans
(Sonnet 22.46, Opus 9.33, DeepSeek 0.26, GLM 0.18), US$ 123.15 of a US$ 150
ceiling; 10 of 95 invocations reported no price. Three continuation runs died
on Sonnet session limits and were salvaged as patches.

## Carried to `safe-to-hand-to-a-friend`

R32 (a detached refusal leaves no run dir), R33 (a session limit waits for its
reset), R34 (a proof that cannot parse is refused at launch), R35 (validate runs
runtime assignment), R36 (the machine-config same-vendor opt-in); and, from the
3b runs, AP1 to AP5 in `docs/campaigns/safe-to-hand-to-a-friend/ACHADOS-PRODUTO.md`.
