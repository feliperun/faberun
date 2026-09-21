# The third review round resolved the mechanical finding and lost the real one

Found 2026-09-20 by running the planner's own frozen contract. It is the
sharpest thing learned about the planner today, and it is not a bug in the
code.

## What happened

The fourth spike run ended `contested` after two rounds, on this surviving
critical finding:

> `r10-node-snapshot-boundary-omitted` — the spec identifies the node snapshot
> as one of the three format boundaries and requires every persisted field to
> get its validator and typedef in the same change, but this node writes only
> `src/contract/index.mjs` and omits `src/contract/snapshot.mjs`.

The fifth run, given a third round, **froze**. Round 2 reported zero critical
findings and the plan sailed through sizing, routing and freeze.

Running that frozen contract, the worker on `requirement-ids-reach-the-node`
refused, correctly, with `context_missing`:

    src/contract/snapshot.mjs (absent from both readFiles and writeFiles):
    validateNodeSnapshot's field set must gain requirementIds — every
    transition persists the node snapshot through writeNodeSnapshot →
    validateNodeSnapshot, which currently refuses the field this node is
    required to stamp, and no file listed in the packet can change that

**The same omission. The extra round did not fix it — it stopped reporting
it.** The round-1 reviewer of run 5 raised the mechanical scope-closure failure
and the reviser resolved that; by round 2 the reviewer no longer raised the
snapshot boundary at all, and a plan that run 4 had correctly refused to freeze
was frozen.

So: the contested plan was, on this point, **more correct than the frozen
one**, and `--review-rounds 3` bought a worse artefact than `--review-rounds 2`.

## Why it matters

It inverts the intuition the flag invites. More adversarial rounds read like
more scrutiny, and here the extra round let a substantive objection lapse while
a mechanical one was cleared. A reviewer that grades a *revised* plan sees a
different artefact and has no memory that it once objected to something the
revision did not touch.

Worth noting what did *not* fail: the engine. The worker refused with a precise
diagnosis naming the exact file, the exact validator, and why no listed file
could resolve it, instead of hacking around its packet. The closed-packet
protocol did its job on a packet that was wrong.

And the omission is the rule this repository has already paid for twice — a new
persisted field needs its validator (`snapshot.mjs`) and its typedef in the same
change. It is written in `AGENTS.md`, and this phase's own spec Constraints
section states it again.

## Candidate fixes, in the order worth trying

1. **Carry unresolved findings across rounds.** A finding the reviser did not
   demonstrably address should be re-presented to the next reviewer rather than
   forgotten. The pipeline already carries outstanding findings forward when a
   revise output fails to validate; this is the same idea for the case where it
   validates but leaves an objection untouched.
2. **Make the reviewer see the previous round's findings**, so the second
   opinion is a second opinion on the *same* questions and not only on the new
   text.
3. Failing both, **do not present `--review-rounds` as monotonic**: document
   that a later round can drop an earlier objection, which is worth stating
   even if 1 or 2 lands.

Option 1 is the smallest and the most obviously right: forgetting an
unaddressed objection is a defect in any review process, human or not.

## Size

Moderate, and confined to `src/plan/pipeline.mjs`: findings carried across
rounds, plus the plumbing to hand a reviewer what is still outstanding. No
engine change, no persisted shape, no contract version.
