# The planner asks for a shape it never describes

Found 2026-09-20 by re-running the planner spike unchanged against `0bfc739`,
the commit that fixed the first two defects. The draft node now reaches `done`
on the first try with no failover and no protocol failure -- defects A and B
are closed, end to end. The pipeline then died anyway, and this is why.

## What happened

`pipeline.jsonl` for the run holds exactly one line, `repo-facts`. The `draft`
stage was never logged, although the draft run itself recorded `status: done`
with a three-node plan in `output.plan`. The detached process vanished between
the two with no log line and no error anywhere an operator would look.

The cause, reproduced directly against the emitted result:

    validatePlanOutput → plan.nodes[0].definitionOfDone[0].id
                         must contain only letters, numbers, dot, underscore, or dash

## Three defects, one root

**C1 -- the required output shape is not stated.** The draft prompt describes
its own deliverable as:

    {nodes: [{id, objective, taskKind, riskTier, dependsOn, readFiles,
              writeFiles, definitionOfDone, verification}], justification?}

`definitionOfDone` and `verification` appear as bare field names. Nothing says a
definition-of-done item is `{id, text, proof?|judgment?}` with an id matching
`[A-Za-z0-9._-]+`, or that a verification entry is `{argv: [...]}`. The worker
guessed, and guessed plausibly:

    definitionOfDone[0] = {"text": "..."}                      // no id
    verification[0]     = {"command": "node --test ..."}       // not argv

Both are rejected. This is not the model failing to follow an instruction --
there is no instruction to follow.

The first spike passed this same point only because that worker went and read
the repository's validators on its own initiative, and said so in its summary:
"My assumption about output shapes was corrected by the repo's own validators,
which is why I ran them." A product whose correctness depends on the model
choosing to go read the source is a coin flip, and this run is the other side
of it.

**C2 -- a malformed plan kills the pipeline instead of becoming a finding.**

    const draft = await runStage("draft", {...});
    let plan = validatePlanOutput(draft.output.plan);   // pipeline.mjs:167, no try
    logStage("draft", {...});                           // never reached

The whole point of the adversarial planner is that a draft is reviewed and
revised. A draft that comes back structurally invalid is exactly the case the
revise stage exists for, yet it is the one case that cannot reach it: the
exception escapes, the detached process exits, and no stage line is written.
The operator is left with a run that says `done` and a pipeline that is simply
gone. The same applies to the revise stage at line 198.

**C3 -- the error names the wrong problem.** `requireId`
(`src/contract/assert.mjs:50`) answers an *absent* value with "must contain
only letters, numbers, dot, underscore, or dash". The field was not
malformed, it was missing. A reader chasing this spends their time looking for
an illegal character that does not exist.

## The fix

**C1**: state the shape where the shape is demanded. `PLAN_OUTPUT_SHAPE` in
`src/plan/template.mjs` already spells the node fields inline; spell the two
nested ones the same way, from the typedefs that define them
(`DefinitionOfDoneItem` in `src/contract/definition-of-done.mjs`, the
verification command in `src/contract/verification.mjs`) rather than from
prose. Keep it short -- the prompt has a 64 KiB guard and this is two lines.

**C2**: catch the validation failure at both stages and turn it into a finding
the revise stage already knows how to consume, with the validator's message as
the finding text. A structurally invalid draft should cost one revision round,
not the run. If every round fails the same way, that is a `contested` result,
which the pipeline already models.

**C3**: have `requireId` distinguish absent from malformed.

## Size

Small and additive. One prompt constant, one try/catch pair that feeds an
existing path, one error branch. No persisted shape, no contract version, no
engine change.

## Why it was invisible until now

Defects A and B killed every planning node before `validatePlanOutput` was ever
reached with a real model's output. `test/cli/plan.test.mjs` supplies plans
from its own well-formed fixtures, so the suite never asked a model to satisfy
an unstated shape. Fixing the first two defects is what made this one
reachable -- the layered growth the repository's own rules ask for, working as
intended.
