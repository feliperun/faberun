# The planner drafts contracts that its own validator refuses

Found 2026-09-20 by the third spike run, at `2744a30` (`faberun@0.12.1`). The
pipeline got further than it ever has:

    repo-facts → draft (4 nodes, plan validated) → review r1 (4 findings,
    0 critical) → sizing (0 transformations) → routing (4 assignments) → ✗

Then it died, between `routing` and `logStage("freeze")`, with no record.

The draft is good work: four nodes, one per requirement plus an end-to-end test
node depending on the other three, sane `writeFiles` counts, real
definition-of-done items and verification commands. It survived review with
zero critical findings. It is the first plan this planner has ever carried that
far.

## What it dies on

Reproduced by replaying sizing, routing and freeze against the emitted plan
with the pipeline's own `cwd` relationship:

    task packet scope does not close; declare in readFiles or writeFiles, or
    acknowledge in scopeAcknowledged: nodes[2] (r11-closure-requirement-map):
    test/cli/cli.test.mjs (imports: runs src/cli.mjs, which imports
    src/campaign/index.mjs)

`freezePlan` calls `validateContract`, and scope closure refuses. This is
**exactly** the error this session's orchestrator hit by hand twice today, on
its own contracts, and resolved both times by pasting the validator's own
answer into `scopeAcknowledged`.

## D1 -- the drafter is never told scope closure exists

The draft prompt mentions scope zero times. `toContractNode` never emits
`scopeAcknowledged` at all. So a plan whose nodes write any widely-imported
module cannot freeze, and the drafter has no way to know: the obligation is not
in the packet, not in the shape, not in the instructions.

Worth being careful about the fix. Auto-filling `scopeAcknowledged` from
`scopeClosureFindings` is tempting -- the detectors are exported, they return
structured `{path, detector, reason}`, and the answer is fully computable
without a model. But that defeats the detector: its stated purpose
(`src/repo/scope-closure.mjs`, paid for by "three incidents in two campaigns")
is to force someone to decide whether the dragged-along importer must *change*.
Acknowledging it silently is the gap it exists to close.

The right fix is the one that just landed for the plan shape: **surface the
validator's own message as a critical finding and let the revise stage act on
it.** The worker can read the repository, so it can decide per file whether to
declare a write or acknowledge a read-only importer -- the same decision the
orchestrator made by hand. One short sentence in the draft prompt about what
`writeFiles` must account for keeps the first draft from being blind, but the
revise loop is what makes it reliable.

This requires an ordering change: freeze happens *after* the review rounds, so
a freeze failure has no round left to consume. Assemble and validate the
contract inside the loop as a pre-flight, so a scope failure is a finding like
any other; `freezePlan` afterwards then runs on a plan already known to
validate.

## D2 -- freeze dies in the same silence, one step further along

`pipeline.jsonl` ends at `routing`. The previous fix closed the silence at the
stage runs and at `validatePlanOutput`/`validateFindings`; `freezePlan` was not
covered, because it is not a stage that runs a model -- it is a local
computation between the last stage line and the next. Same operator experience:
a detached process that vanishes, and a log that stops mid-sentence.

The pre-flight above removes most of this by construction, but `freezePlan`
itself should still be wrapped so that no path out of this pipeline is
unrecorded.

## Size

Moderate: the contract assembly (`toContractNode` + sizing + routing) moves or
is duplicated into a pre-flight inside the round loop, a validation failure
becomes a finding through the `invalidPlanFinding` path that already exists,
and the draft prompt gains one sentence. No new persisted shape, no contract
version change, no engine change.
