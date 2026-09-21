# The scope-closure finding is cheapest to satisfy by writing less

Found 2026-09-20 by running the planner's frozen contract and then tracing
*why* it was wrong. This supersedes the softer reading in
`a-third-round-traded-a-real-objection-for-a-mechanical-one.md`: the objection
was not forgotten, it was **engineered away**, and the pressure that did it is
one this session introduced earlier the same day.

## The evidence, three snapshots of the same node

| plan | writeFiles | has `snapshot.mjs` |
| --- | --- | --- |
| spike 1 draft, no review at all | 12 | yes |
| spike 5 **draft** | 8 | **yes** |
| spike 5 **frozen**, after review + revise | 5 | **no** |

The draft was right. The revise removed it. `sizing` reported `0
transformations`, so sizing is not the cause.

Then the worker refused, correctly:

    src/contract/snapshot.mjs (absent from both readFiles and writeFiles):
    validateNodeSnapshot's field set must gain requirementIds … and no file
    listed in the packet can change that

A second, identical mechanism surfaced one attempt later on the *corrected*
contract: `test/campaign/field-ownership.test.mjs` fails and is undeclared, so
the worker cannot fix it. `docs/FIELD-OWNERSHIP.md` was in spike 1's draft too,
and is gone by spike 5.

## The mechanism

1. The draft declares the writes the work actually needs.
2. The in-round preflight -- added today, in `d4ad4db` -- validates the
   assembled contract, and scope closure refuses: writing those files drags in
   importers that are not declared.
3. The finding handed to the reviser is the validator's raw message: *declare
   in readFiles or writeFiles, or acknowledge in scopeAcknowledged*.
4. **Removing a file from `writeFiles` also satisfies it**, and is by far the
   cheapest move: fewer writes drag in fewer importers, and the finding
   disappears without a single judgement about which importer actually breaks.
5. The plan freezes, under-scoped, and the defect lands on the worker.

So the gate rewards shrinking the work. That is a property of any mechanical
gate whose failure can be cleared either by doing more thinking or by doing
less work -- and this one was introduced, by me, as the fix for a silent death.
Dying silently was worse, so this is not a reason to revert; it is the
mitigation that fix still owes.

## The fix

**Say it in the finding.** The text handed to the reviser is currently the
validator's message alone. It should carry the one sentence the validator
cannot know: *resolve this by declaring the dragged-along file or acknowledging
it, never by removing a file the node needs to write.* Cheap, and it addresses
the actual failure -- the reviser was not told that one of the two available
moves is illegitimate.

**Then check it.** Compare the revised plan's `writeFiles` against the previous
round's, per node, and raise a finding when a path disappears: a write the
draft thought necessary and the revision dropped is exactly the event worth a
second look. This is the same shape as carrying unresolved findings forward,
and it makes the erosion visible instead of inferable three runs later.

Both live in `src/plan/pipeline.mjs`, beside `invalidPlanFinding`.

## What this says about review rounds generally

The earlier note framed this as "a later round dropped an earlier objection".
That framing was too kind. The reviser *acted* on the finding, and the action
it chose made the plan worse. A review loop is only as good as the set of moves
its findings invite, and this one invited the wrong move by omission.
