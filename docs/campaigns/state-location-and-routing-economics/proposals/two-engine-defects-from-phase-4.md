# Two engine defects, found by running phase 4

Both observed 2026-09-21 on run
`state-location-and-routing-economics-13-routing-economics`, and both verified
rather than inferred.

## A. `maxParallel: 1` does not hold

Two workers ran concurrently:

    declare-routing-strategy      inv f85d8515  phase worker  pid 7717   alive
    measure-repeated-packet-bytes inv 4e6256f6  phase worker  pid 10471  alive

`maxParallel` reads `1` in the authored contract and in the run's own persisted
`contract.json`. Both invocations carry `phase: worker` and a dispatched
runtime, and both pids answered `ps`. So this is genuine concurrency, not a
snapshot that merely reads stale: a node whose job had finished would not hold
a live pid.

`scheduler.mjs:611` computes `const slots = contract.maxParallel - running.size`,
which is the right shape, so the fault is upstream of that arithmetic — most
likely `running` not yet holding a job the scheduler has already dispatched, or
a second dispatch path that does not consult it. Worth finding before trusting
the number anywhere else: every cost and duration estimate in this campaign
assumed serial execution, and two of the three OOM kills today happened while
more was running than intended.

Not urgent for correctness — the nodes are independent and the work is sound —
but a declared limit that does not hold is worse than no limit, because it is
planned around.

## B. The undeclared-test message gives dangerous advice for a ratchet

`measure-repeated-packet-bytes` failed `sharedVerification` because
`src/report/render.mjs` reached **801 lines** against the repository's 800-line
ceiling. The engine reported it as:

> deterministic verification failed in undeclared test file
> `test/repo/source-shape.test.mjs`; the node's writeFiles does not include it,
> so the worker cannot fix the failing test. **This is a contract defect, not a
> worker defect: add it to writeFiles or scopeAcknowledged and re-dispatch**

(`src/engine/judge-gate.mjs:366`.)

For an ordinary test that a node's change breaks, that advice is right. For a
**ratchet** it is exactly backwards. The failing check is
`no file in the repository exceeds 800 lines`, and the remedy is to trim the
code back under the ceiling — which the node can do with the files it already
holds. Following the engine's advice would put the ratchet itself in
`writeFiles`, licensing a worker to edit the rule that is failing.

This repository's own `AGENTS.md` says it in one line: *"Raising the ceiling is
not a fix."* The engine currently suggests handing over the pen.

### Fix

Distinguish the two cases before advising. A failing undeclared test that the
node's writeFiles could plausibly own is a scoping defect and the current text
is correct. A failing **ratchet** — the files in `sharedVerification`, or a
named set including `test/repo/source-shape.test.mjs` — is a work defect: the
message should say the change violates a repository-wide rule and name the
rule, and must not suggest adding the ratchet to `writeFiles`.

The cheapest honest version: when the failing file is one the contract declares
in `sharedVerification`, say so and drop the `add to writeFiles` clause.

## Size

A is unknown until the dispatch path is read; B is one function in
`src/engine/judge-gate.mjs` plus a test.
