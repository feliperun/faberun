Campaign chain-ergonomics-and-fairness, 2026-09-17 15:07 UTC to 19:30 UTC (4.4 h):
fifth campaign of the improvement loop and the one aimed at the factory's own
ergonomics, Anthropic models only (claude-sonnet-5 workers USD 36.52,
claude-opus-5 judge USD 6.41, USD 42.93 in all), four runs (1, 1b, 2, 2b) over
nine node instances, 13 attempts and 21 provider invocations, driven by
`supervise campaign` from the installed 0.9.0 CLI. Landed on main by a `--no-ff`
merge (51228cb) with 1112 tests green, both eval passes at 20/20 and
`docs:check` clean.

Delivered, by requirement. R1 and R2: `run --base-ref <ref>` validates the
contract against the ref the worktrees will be cut from instead of against the
checkout, in `src/cli.mjs` and in `runContract()`, so a chained contract whose
`readFiles` name files the previous phase created launches without the operator
detaching the checkout -- the engine defect the previous campaign had to work
around. R3: a free slot dispatches while another node verifies, and the dispatch
pass's judge branch is chained onto the settlement queue rather than awaited
inside the tick, so it can no longer run concurrently with a background
settlement integrating on the same candidate ref, and a background settlement
that rejects is recorded and re-checked after the post-loop await instead of
being swallowed by a clean exit. R4: the contract's `finalVerification` runs
once per phase, on the integrated candidate of the last phase-terminal node to
settle, so three terminal nodes run the suite once and a flake elsewhere cannot
cost three nodes their revision budget; a retry after that close carries it
again. R5 and R7: candidate verification carries its own `executionPhase` end to
end, the human table shows the gate outcome next to the verdict, and the
dashboard row reads `gateOutcome` and `executionPhase` from the status payload
instead of re-deriving `node.gate?.verdict`, so an advisory-pass node no longer
reads `fail` on either surface. R6: `campaign unpark` naming `--force` and the
promotion refusal naming the detached checkout.

What this campaign cost and why. Phase 1 split once for the familiar reason: the
`base-ref-validation` node was blocked `context_missing` because its packet's
write scope did not name every file the change forces, and contract 1b carried
the complete set and closed on the first attempt. Phase 2 was the expensive one:
all three nodes exhausted their revision cap, each with work the judge had
confirmed and one precise remaining gap, so the orchestrator landed the three
attempts by hand (c022e64, 1388c92, 6212d85) and authored contract 2b from the
judges' verbatim findings. That is the documented path and it worked, but it
cost three revision cycles to learn three things a more complete packet would
have said up front: the D14 eval case is part of the finalVerification change's
scope, the judge branch of the dispatch pass is part of the dispatch change's
scope, and the dashboard is part of the status change's scope. Every one of the
three is the same authoring failure as the one AGENTS.md already records --
`writeFiles` lists what the change forces to change, not what it intends to --
and this campaign is the third in a row to pay for it.

One conflict was resolved by hand and is worth recording: the once-per-phase
change and the candidate-phase change both edited `verifyCandidateWorkspace`,
one adding the settled-sibling argument and the other the `lock` parameter and
the phase marker. The resolution keeps both. Landing two exhausted nodes'
patches in sequence against a moving tip is a real cost of the
exhaust-then-land path, and `git apply -3` is what makes it survivable.

The judge earned its cost again. It found that the once-per-phase rule made
D14's declared discriminator inert -- the mutation no longer changed the
outcome, so the case passed but proved nothing -- and it found that the status
work had not reached the dashboard, naming the exact line that re-derived the
verdict and the exact column that rendered it. Neither was a worker defect;
both were packet scope, and the judge said so in those words.

The D14 rewrite is the small lesson of the campaign. A case whose claim survives
a rule change still needs a new mutation, because the discriminator proves the
rule and not the claim. The new mutation removes the contract's
`finalVerification` array, which collapses the empty-commands guard so the
phase's last node settles `done` instead of `failed` -- a different outcome pair,
observable through the rule as it now is.

Open follow-ups: the six defects this campaign was written for are closed, so
what remains from the loop's retrospectives is operational or already deferred by
the owner -- running the live planner arm, which costs real money and is the only
thing that can say whether the planner beats session authoring, plus the
evidence layer and mutation testing. The owner has since written the sixth
campaign, `state-location-and-routing-economics` v1.1.0, whose 19 requirements
move run state out of the target repository, carry requirement ids from the plan
to the node and into closure, and put routing economics on observable data. Its
own spec declares 83 literal run-path references in `src/`; measured on this
landing the exact literal `".runs"` appears 31 times in 20 files of `src/`, 176
times in `test/` and 7 in `evals/`, so its R1 metric needs re-anchoring to the
counting rule its test will use.
