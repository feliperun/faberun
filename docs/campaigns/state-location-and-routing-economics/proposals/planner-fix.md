# Fixing the planner before spiking it

Written 2026-09-18. The journal entries `scope-closure-diagnosis-corrected`
and `fix-the-planner-then-spike-it` both hit the 2048-byte truncation
(`JOURNAL_TEXT_BYTES`); this file is the whole argument, unbounded.

## The owner's question and what it actually found

The owner asked how the orchestrator's accuracy becomes deterministic rather
than a product of one operator's accumulated memory — could a fresh agent on
any harness get it right with no memory of this session. Answered by
auditing `src/repo/scope-closure.mjs` against this campaign's own record.

First diagnosis (wrong, corrected below): the reverse-import detector
abstains when a packet declares no `symbols`, so a node that moves a name
between modules without declaring it draws no finding. True as a description
of the code, but the fix implied — derive the surface from the tree instead
of trusting the declaration — was tested and produces 55 findings for one
node, the exact flood the module's own header says it was built to avoid.

Corrected diagnosis, measured against the tree at `a9847c5~1` (the commit the
node that exhausted twice was based on): with the two relocated names
(`attemptWorktreePath`, `candidateWorktreePath`) actually declared in
`symbols`, the existing detector already returns exactly the seven files that
had to be in scope. With the three unrelated names the orchestrator actually
declared, it returns two. **The check was never missing. The declaration was
incomplete, because `AGENTS.md` named two cases — a name a node introduces,
and a name it merely uses — and the costly case is a third: a name a node
*relocates*, which is neither.** Fixed in `AGENTS.md` at commit `785ba7f` and
in `skills/faberun/references/contract.md` (where an agent on another
repository actually reads the rule) at commit `08949fb`, both with the
measurement in the commit message.

## Why the planner is the same defect, one layer up

The planner drafted phase 1 of this campaign once (before it was reauthored
by hand) and named 14 modules that did not carry the pattern R1 was about,
while missing 6 that did. Reading `src/plan/repo-facts.mjs` explains why, and
it is structural rather than the model being careless: `RepoFacts` carries
`formatVersion`, `gitHead`, a path list, npm scripts, verification candidates
and test files — an inventory of what the repository *contains*, nothing
about what it *says*. A requirement like R1, whose entire subject is an
occurrence pattern in source text, hands the planner a prose statement and a
file list and asks it to infer which files match.

Same failure mode as the scope-closure defect, same cause: the measurement
reaching the author is narrower than the question being asked. The
difference is that an orchestrator learns inside a session and a planner
starts every draft cold — which is exactly the determinism problem the owner
raised.

## The decided shape of the fix

`SpecRequirement` (`src/plan/spec.mjs`) already carries `id`, `title`,
`statement`, `proof`, `constraints`, `line`. A requirement should be able to
declare *what to measure*, separably from `proof`: the planner runs that
measurement read-only and the result joins `RepoFacts` before drafting.

`proof` is close but not sufficient on its own: for R1 the proof was a
ratchet test the node itself was going to write, so it did not exist yet at
planning time. The declaration has to be something that can be evaluated
*before* the work exists — most naturally a grep pattern or a small read-only
script, evaluated the same way `preflight --time-verification` already
evaluates a verification command without launching a model.

Scope, once authored: a spec-format change (the new field), a
`repo-facts.mjs` change (run the declared measurement, fold the result into
`RepoFacts`), and a line in `skills/faberun/references/spec-format.md` so an
author of a future spec knows the field exists. The node that does this
should be given this diagnosis, not asked to redo it.

## The spike, after the fix

`evals/planner`'s comparative arm scores the planner against *recorded
campaign history* — data that already existed when the planner ran. That
answers whether the planner would have matched a past decision, not whether
it makes a good decision on live work. The spike compares planner output
against session authoring on real, currently-unauthored requirements: R5, R6,
R8, R9-R11, R12-R19. Comparing before the fix would measure a blind planner
against a sighted orchestrator, and that result is already known — this
campaign's own phase-1 planning attempt is the evidence.

## Order

1f (running) → 2c (R2, approved) → 0c9 (dashboard) → **this fix** → pricing
phase → the spike → the spec's phases 3-6.
