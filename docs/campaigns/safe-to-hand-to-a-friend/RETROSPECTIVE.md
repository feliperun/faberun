# Retrospective: `safe-to-hand-to-a-friend` (campaign 3b)

Closed 2026-09-28. Every requirement is integrated on
`campaign/safe-to-hand-to-a-friend`, and `faberun spec validate --run-proofs`
passes every proof in `spec/SPEC.md` on that branch.

## What landed

| requirements | phase | how it ran |
| --- | --- | --- |
| R1 to R4 (environment allowlist, `doctor --env`, declared environment per adapter) | 1, 1b, 1c | phase 1 planned; 5 of 8 nodes exhausted on the AP1 proof defect and were carried by the hand-written continuations 1b and 1c |
| R5 to R7 (executed getting-started, legacy layout swept, repo facts beyond Node) | 2, 2b | R6 failed on a proof stricter than the spec (AP11) and was replanned as 2b with the salvaged patch |
| R8 (a stranger's first campaign completes offline) | 3r8 | the phase-3 node did the work and exhausted on a proof `/bin/sh` could not parse (AP13); replanned alone |
| R10, R12, R13 (reauthor, sandbox cost stated, operator override of a packet defect) | 3 | planned and run |
| R11 (`faberun uninstall`) | 3r11 | held out of phase 3 as irreversible until the owner authorised it with isolation: temporary `HOME` and `FABERUN_HOME` in every test and trial, deletion only under the injected root |
| R22 to R29 (agent-belt retrospective) | 4 | planned and run |
| R30 to R36 (carried from `planner-and-routing`) | 5 | planned and run |

Repaired by hand on the branch, as code and not as contracts: four
structural failures phase 1 integrated (`1ab2243`, `3a501a5`, `4c67a3d`,
`a567d03`, AP7), a `shellWords` escape bug and three stale expectations the
later phases left behind (`8d9cce4`, `9563a00`, AP15), and the R8 proof in the
master spec, which still named the test title 3r8 renamed (`77a9532`).

## The gate, one item missed

| gate item | met |
| --- | --- |
| a planted secret never reaches a worker | yes (R1 to R4) |
| the getting-started guide is checked in CI | yes (R5) |
| a stranger's first offline campaign is green | yes (R8) |
| 3b closed with 0 hand-written contracts | **no**: phase-1b and phase-1c |

The two continuations were written by hand on 26/09, before the owner's
27/09 authorization forbade it, to carry five nodes that exhausted on a proof
that measured nothing. Every other contract of the campaign (phases 1, 2, 2b,
3, 3r8, 3r11, 4 and 5) came from `faberun plan`. Decision
`gate-hand-written-continuations` closes the campaign with the miss stated
instead of replanning R1 to R4: the code is integrated and proven, and the gap
that forced a hand continuation, no way back from a failed node into the plan,
is what R10 and R13 delivered here. Campaign 4 has to meet the item with no
exception.

## What the running taught

Twenty-one product findings, in `ACHADOS-PRODUTO.md`. Three shapes repeat:

1. **A proof that cannot fail, or cannot pass, reaches a worker.** AP1 (a
   name filter with no file prints a zero plan), AP11 (a proof stricter than
   the spec), AP13 (a proof the shell cannot parse), AP8 (the spec's own proof
   had no file). AP1 and AP2 were fixed in 0.26.0; the freeze now refuses a
   filtered proof that names no test file. Each of the others cost one replan.
2. **A phase integrates green nodes into a red tree.** AP7 and AP15: every
   node ran its own verification, none ran the neighbours, and four phases
   left regressions the full suite found only afterwards.
3. **A failure the operator cannot read.** AP4, AP10 and AP16: a detached
   plan dies as "failed before readiness", with the cause only visible when
   the stage runs in the foreground.

## Spend

US$ 36.90 against a US$ 60 ceiling: US$ 3.37 in runs (all ten phases) and
US$ 33.53 in plans. US$ 32.23 of the plans is the phase-1 plan that was the
3a gate, also counted in `planner-and-routing`'s close; without it the
campaign cost US$ 4.67. Workers ran on DeepSeek Flash through `dsh`, judges
on GLM through `zcode`.

## Carried forward

AP3 to AP21 feed the next faberun-improvement campaign, in this order: AP15
(run the full suite before integrating a phase), AP10 and AP4 (a detached
refusal names its cause), AP13 (refuse at freeze a proof `/bin/sh` cannot parse; R34
covers only the body of a `node -e`), AP17
(the revise returns a patch, not the whole plan).

Written at the close, on 2026-09-28. Every finding this order names was
corrected the same day: AP10 and AP4 in 0.29.0, AP13 with the rest of that
leva, and AP15 and AP17 in 0.30.0. Of the twenty-one, only AP9 (RM-108) is
open, deferred by the owner. The verdict table in `ACHADOS-PRODUTO.md` is the
reader that stays current.
