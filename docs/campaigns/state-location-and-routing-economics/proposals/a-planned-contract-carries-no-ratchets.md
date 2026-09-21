# A planner-authored contract carries no ratchets

Found 2026-09-20 by reviewing the first contract the planner ever emitted
(`requirement-traceability-5`, frozen at `d4ad4db`). The contract is valid, the
node design is good, and it is materially weaker than any contract authored by
hand in this campaign, in exactly the dimension this repository cares most
about.

Its keys are: `campaignId`, `contractVersion`, `cwd`, `goal`, `id`, `nodes`,
`runtimeDefaults`, `runtimes`, `schemaVersion`.

Absent: **`sharedVerification`** and **`finalVerification`**. `grep -rn` over
`src/plan/` finds neither string. The concept does not exist in the planner.

## Why it matters, with today's evidence

`sharedVerification` is where this campaign puts the ratchets that run on
*every* node: `source-shape.test.mjs` (no duplicate top-level body, no file
over 800 lines, no empty catch, no test bounding a duration from above),
`field-ownership.test.mjs`, `brand.test.mjs`, `docs-diet.test.mjs`,
`host-layout.test.mjs`, `reference-load.test.mjs`.

Today that gate earned its place twice:

- Contract 5's second node copied `pathInside` byte-for-byte into
  `repo/worktree.mjs`, and the duplicate-body ratchet caught it mid-run. The
  node spent its revision fixing it. Without `sharedVerification` that copy
  lands.
- Every hand-authored contract in this campaign has also carried
  `finalVerification` -- the full suite plus both eval classes on the
  phase-terminal node -- and it has caught regressions a node's own narrower
  list missed, repeatedly, including the four regressions behind `5259869` and
  `419b87c`.

A planned contract has neither. Its nodes are guarded only by whatever
verification the drafter thought to write, which is per-node and necessarily
narrower than a repository-wide ratchet the drafter has never been told about.

## The fix, following the precedent already in the CLI

`--runtimes <path>` already exists: the operator hands the planner a JSON
catalogue in the contract's `runtimes` shape, because a runtime catalogue is
the operator's, not something a planner can invent. Verification suites are the
same kind of thing -- campaign-wide, operator-owned, stable across phases -- and
want the same treatment: a `--verification <path>` whose JSON carries
`sharedVerification` and `finalVerification` in the contract's own shape,
threaded through `runPlanningPipeline` into `freezePlan`.

Deriving them from repository facts is the tempting alternative and is worse:
which ratchets a repository wants on every node is a policy decision, and
guessing it produces a contract that looks guarded and is not.

If neither is supplied, `faberun plan` should say so -- a warning on freeze that
the contract carries no shared or final verification, the same way
`contract validate` already warns about a near-ceiling write or an uncovered
command target. Silence would let this stay invisible exactly as it just was.

## Size

Small: one CLI flag, one option threaded through the pipeline, two fields on
the frozen contract, one warning, and tests for the supplied and omitted cases.
No engine change, no persisted shape, no contract version change.

## Until it lands

The emitted contract is worth running, and the missing suites can be supplied
by hand -- the same treatment `scopeAcknowledged` got: keep the planner's work,
add the piece it cannot yet express, and record the gap.
