# The orchestrator's own failure mode, measured across six refusals

Six packets I authored today were refused by their worker with
`context_missing`, and every one named the exact file, the exact line and the
exact reason. That is a good protocol working. It is also six instances of one
mistake, and the mistake has a shape worth naming rather than resolving to be
more careful about.

## The six

| packet | I said | it actually lives in |
| --- | --- | --- |
| R10 (phase 3) | the contract layer | `src/contract/snapshot.mjs` — the validator refuses the field |
| R10, again | — | `docs/FIELD-OWNERSHIP.md` + its enforcing test |
| `--verification` | "src/cli/plan.mjs's option table" | `COMMAND_OPTIONS.plan` in `src/cli.mjs:124` |
| R17 | workflows only | `evals/run.mjs` — `--class` had no scoping |
| R19 (first) | — | `test/host/ci-policy.test.mjs`, which R17's own test reads |
| R19 (second) | "the failure-policy module" (`failover.mjs`) | `AUTO_RETRY_CODES` in `lifecycle.mjs:151`, `NON_FAILOVER_CODES` in `backoff.mjs:34` |

## The shape

**I locate a declaration by the name of the module rather than by searching for
it.** `failover.mjs` sounds like where failure classes live; they are in
`lifecycle.mjs` and `backoff.mjs`. `cli/plan.mjs` sounds like where the plan
command's options are declared; they are in `cli.mjs`. Both times the name was
a plausible story and the story was wrong.

The second half is narrower and cost three of the six: **I list what the change
is *about* and miss what the change *forces*.** R17 is "about" workflows, but
moving a class off the merge path forces the runner to be able to name a class.
R19 is "about" evals, but amending a workflow forces the test that reads that
workflow as text.

Worth noting what did *not* catch these: scope closure. Its detectors follow
imports, symbols and directory listings, and every one of the six is a coupling
of a different kind — a validator that refuses a field, a registry a test
enforces, an option table in a sibling module, a workflow read as text. The gate
is not weak; those couplings are simply not in its graph.

## The rule

Before naming a file in a packet, `grep` for the declaration. Not "which module
owns this concept" — `grep -rn "<the identifier>" src/`. The difference between
the two took six refusals to show up, and each refusal cost a dispatch, a
worker's context window, and in one case a node's revision budget.

The corollary for `writeFiles`, which `AGENTS.md` already states and I still
missed three times: list what the change **forces** to change, then check each
one by opening it.

## What this is not

Not a worker-quality problem. In all six the worker read its packet, found the
gap, named it precisely, and stopped rather than guessing — which is exactly
what a closed packet is for, and is the reason none of the six became a bad
landing instead of a lost dispatch.
