# faberun evals

`run.mjs` discovers deterministic eval cases and runs them with zero model
invocations: every runtime in every case uses the `replay` harness
(`src/harnesses/replay/index.mjs`), consuming a
recorded envelope instead of calling a real provider CLI.

## Paths inside a golden task

A golden task's `verify.json` records the verification commands the task
declared, and `--validate-golden` only checks that they parse as a valid command
list -- nothing ever runs them against the current tree, and nothing should.
Each task restores its own `meta.parentSha` from `golden/fixtures.bundle`, so its
commands belong to *that* commit's layout.

That is why several of them still name a `scripts/…` directory under the old
`skills/mine/` skill path: the scripts moved to `src/` on 2026-09-11 and the
whole tool moved to the repository root on 2026-09-15, but each task's parent
commit predates both. Those are not stale paths to repair: rewriting them to
today's `src/…` would point a historical task at files its own parent commit
does not contain. See `../docs/history/README.md` for the mapping if you are
reading one and want the file as it is now.

## Usage

```
node evals/run.mjs --class deterministic [--case <id>] [--repeat <n>] [--assert-no-model] [--verify-discriminating] [--json]
```

- `--class deterministic` runs every case under `evals/deterministic/`.
- `--case <id>` narrows to one case (combine with `--class deterministic`).
- `--repeat <n>` runs each case `n` times, sequentially, and reports it ok
  only when every run is; the summary shows `passes/repeats` and each
  failing run's failures carry their ordinal. A case that passes once and
  fails once is a flaky case, and this is how it reads as one instead of
  as whichever run happened last.
- `--assert-no-model` additionally fails if any case's contract declares a
  runtime whose harness is not `replay`, and runs with
  `FABERUN_CODEX_BIN`, `FABERUN_CLAUDE_BIN`,
  `FABERUN_AGY_BIN`, and `FABERUN_GLM_BIN` unset, so any code
  path that actually needed one of those to resolve a provider CLI fails
  loudly instead of silently reaching a real local install.
- `--verify-discriminating` does not check any case against its
  `expected.json`. Instead, for each case it applies the case's declared
  `discriminator` mutation (see below) to a fresh copy of its `setup` steps
  and requires the mutated run to fail. A case that still passes with its
  discriminator applied does not prove what it claims and is reported as a
  failure naming the case; a case with no `discriminator` block is also a
  failure. Combine with `--case <id>` to check one case.
- `--json` prints the report as JSON instead of a human-readable summary.
- An unknown flag exits 2.

## Paired class

```
node evals/run.mjs --class paired --budget-usd <n> [--corpus <id>] [--repeat <n>] [--seed <n>] [--result-dir <dir>] [--json]
```

The paired class is the `orchestration-arms` driver brought into main
(`evals/paired.mjs` plus `evals/paired/`). It runs the arms declared in
`evals/paired/arms.json` -- the spike's A to J, with the same writers: A the
faberun arms with a blocking codex judge, B and C one claude session without
and with the `Agent` tool, D proof-only, E to J D with the writer swapped for
DeepSeek Flash, opus, sol, luna, astra and GLM Flash -- over one corpus in
`evals/paired/corpus/<id>/`. Arms run sequentially, in an order shuffled by
the recorded seed (one shuffle per repetition), `--repeat <n>` times.

It refuses to start without `--budget-usd` and reserves every arm's declared
estimate through `evals/budget.mjs` before the arm begins; an arm that cannot
fit the remaining allowance is reported as skipped rather than started. The
result lands in `evals/results/paired/` (or `--result-dir`); the report gives,
per arm, the proofs delivered (the proofs that pass only while every guard
passes), the cost per delivered proof, wall clock, requests when the harness
measures them, out-of-scope files, and the band: minimum and maximum always,
and a 95% interval by resampling once `--repeat` is 3 or more. A metric a run
did not measure is reported as no band, never as zero.

Each acceptance check declares `kind: "proof"` or `guard`. The checks without
`restore` run on the arm's tree exactly as the arm left it; then the corpus's
accepted files are written over it and the `restore` checks run, so the landed
acceptance never runs over the arm's own copy of it. The proof tests
(`test/evals/paired.test.mjs`) drive the whole class with deterministic
`replay` arms over a small fixture corpus and never call a provider.

## Judge-canary class

```
node evals/run.mjs --class judge-canary --runtime <id> --budget-usd <n> [--repeat <k>] [--seed <n>] [--result-dir <dir>] [--json]
node evals/judge-canary.mjs [--verify-discriminating [--json]]
```

The judge canary measures one judge runtime against sealed cases whose label
is known. `--runtime` names an entry of `evals/judge-canary/runtimes.json`
(id, harness, model, and `estimateUsd`, the amount reserved per invocation);
the class refuses to start without a known runtime and without
`--budget-usd`, and it spends through `evals/budget.mjs` like the paired class.

**Corpus.** `evals/judge-canary/corpus.json` is the hand-authored source: for
each of 10 golden tasks, the packet a real contract would give it (objective,
instructions, non-goals, the task's behaviours as judgment items), and 25 defect
edits, 5 per kind, each kind spread over 5 distinct tasks. `node
evals/judge-canary.mjs` builds one case directory per clean control (the task's
golden diff, byte for byte) and per defect (the golden diff with the edits
applied), each holding `case.json` and `diff.patch`. A defect edits only files
the golden diff already changes. The kinds are `nongoal-violated`,
`requirement-half-done`, `scope-drift-inside-writefiles`,
`doc-contradicts-code` and `test-weakened`. Every task's verification runs a
`node --test` over the code it changed, so a passing verification means
something.

**Discrimination.** The builder runs every case's verification over its own
tree, which is the parent tree plus the sealed diff. It refuses a clean control
that fails and refuses, by case id, a defect that a verification catches,
because such a defect does not measure the judge. `--verify-discriminating`
reruns that check over the committed corpus. It takes about two minutes and
needs POSIX, because the golden tasks' tests are this repository's own
2026-09 suite.

**What the judge sees.** Each case is asked through the product's own
`judgePrompt` (`src/engine/prompts.mjs`): the task's node id, its packet, its
Definition of Done, a worker result that claims the task was done, and, as
diff paths, the paths the sealed diff changes. Every case of a task gets the
same prompt, so the label, the case id and the defect's description never
reach the judge. A harness judge reviews a git repository with the parent
tree committed as `base` and the sealed diff left uncommitted. The product
prompt carries no `nonGoals`, so a `nongoal-violated` reading measures a judge
that has to find the violation without seeing the non-goal.

**Score.** The result is written to
`evals/results/judge-canary/<date>-<runtime>.json` (or `--result-dir`). A
second run of the same runtime on the same day writes `<date>-<runtime>-2.json`
and does not overwrite the first. Per label, the result gives invocations,
verdicts, errors, rejections, and the cost per case. Recall is the share of a
kind's verdicts that reject with a finding citing a judgment item id. The
false-alarm rate is the share of clean verdicts that reject. An invocation
that threw or returned a verdict `parseJudge` refuses counts as an error for
its label and is left out of both rates. The provenance fields are the same
as the paired class's. The proof tests (`test/evals/judge-canary.test.mjs`)
score an always-pass and an always-reject `replay` judge and never call a
provider.

## Indicator projection and comparison

```
node evals/run.mjs --project <runDir>... [--campaign <id>] [--note <text>] [--json]
node evals/run.mjs --band <report.json> <report.json>... [--json]
node evals/run.mjs --compare <before.json> <after.json> [--band <band.json>] [--json]
```

`--project` reads one or more orchestrator run directories' own
`events.jsonl` and `usage.jsonl` (never a node snapshot or a hand-written
number — see `evals/metrics.mjs`'s `projectEvalIndicators`) and prints the
indicator report: `costPerClosedCheckpoint`, `firstPassGateRate` (grouped by
node id), `judgeInvocationRate`, `revisionsPerDone`, `blockedContextRate`,
`wallClockPerClosedCheckpoint`, `providerFailoverRate`, and
`protocolFailureRate`. An indicator with no supporting record is `null`,
never `0`. More than one `<runDir>` concatenates their records first — a
campaign built from several sequential orchestrator runs has no single
directory holding every record. The printed report carries a `provenance`
block (`campaign`, `runIds`, `runDirs`, `generatedAt`, `note`) so it can be
regenerated and checked against the run directories it claims to measure;
`evals/baseline.json` and `evals/fixtures/{a,b}.json` are this command's own
output, not written by hand.

`--band` reads two or more such reports from repeated runs of the same
setup and prints, per indicator, the noise band (half the range of the
measured values), the median and the number of readings; an indicator with
fewer than two readings has no band, because one reading is not a spread.
Measured 2026-09-20: the same packet on the same model varied by a factor of
3.3 across 10 repetitions in one campaign and 2.12 across 2 in another, so a
comparison of one run per arm reports noise as a result.

`--compare` reads two such reports (either the bare indicator map or the
`--project`-shaped `{provenance, indicators}` wrapper) and prints, per
indicator, each side's value and sample count, the delta, and the direction
that counts as improvement. Comparing a `null` indicator against a measured
number never produces a numeric delta — it reports "no data"
(`comparable: false`) instead of a delta that would silently read as zero.
With `--band <band.json>` (the `--band --json` output) each comparison also
says whether the delta is outside that indicator's noise band; a delta
inside it prints as "not measured", never as a number that reads as a
result, and `significant: false` in the JSON.

Exit code is 1 if any case fails, 0 otherwise.

## Comparative arm

```
node evals/run.mjs --arm session|planner [--json]
node evals/run.mjs --validate-planner-arm --min <n> [--json]
```

The comparative arm asks the same question `--project`/`--compare` ask of one
run, across two disjoint, already-closed sources instead: the **session**
side reads the preserved records under `docs/campaigns/*/ledger` (a real,
human-directed session's own campaign journal, usage ledger and landed
contracts) for every campaign that also carries a structured
`spec/REQUIREMENTS.md` sibling (see `test/plan/existing-specs.test.mjs`); the
**planner** side reads operator-saved reports under
`evals/planner/reports/<campaignId>.json`, each one a record of running
`faberun plan` against that same campaign's `REQUIREMENTS.md`. Neither side
runs anything live and neither ever edits a preserved record —
`evals/planner/arm.mjs` only reads.

Both sides project the same six indicators (`costPerClosedCheckpoint`,
`planningCost`, `firstPassGateRate`, `blockedContextRate`,
`nodesPerClosedCheckpoint`, `criticalFindingsPerPlan`), each the usual
`{value, direction, count}` shape averaged across every qualifying campaign
or report; an indicator with no supporting record on a given side is `null`
for that side, never `0`. Because the ledger keeps no per-node
`events.jsonl`, several session-side indicators are coarser than
`--project`'s: `costPerClosedCheckpoint` divides ledger usage cost by the
count of `REQUIREMENTS.md` requirements whose proof names a file that exists
on disk (the ledger's own stand-in for "a closed checkpoint"),
`nodesPerClosedCheckpoint` divides the node count summed across the
campaign's `control/*.contract.json` files by the count of distinct `runId`s
its `campaign.json` promoted, and `firstPassGateRate`/`blockedContextRate`
are mined from the journal's own free-text `outcome`/`decision` notes
(`"...on the first attempt"`, `"...blocked..."`) — a coarse text proxy that
reports `null` for a campaign whose notes never mention an attempt count,
rather than a rate over zero notes. `planningCost` and
`criticalFindingsPerPlan` are always `null` on the session side: no session
ever recorded a planning phase or a plan review separately from its worker
spend.

`--arm session` writes `evals/planner/session-arm.json`.
`--arm planner` writes `evals/planner/planner-arm.json`, or exits 1
explaining there is nothing to write when no report exists yet under
`evals/planner/reports/`. Producing a planner report is an operator action
outside any one campaign: run `faberun plan --spec docs/campaigns/<id>/spec/REQUIREMENTS.md ...`
against a campaign's own requirements, then save
`{schemaVersion: 1, campaignId, usage: [...the planning pipeline's own usage
records, same shape as a ledger's *.usage.jsonl...], plan: {nodeCount,
roundsUsed, criticalFindings, blockedAttempts}}` to
`evals/planner/reports/<campaignId>.json` by hand. `plan.nodeCount` is the
frozen plan's node count, `plan.roundsUsed` is how many draft/review/revise
rounds it took before freezing (`1` means first-pass), `plan.criticalFindings`
is the count of `critical`-severity findings the plan's own review raised,
and `plan.blockedAttempts` is how many of its worker invocations returned
`blocked_context`; any of the four left out reports `null` for the indicator
that needed it, exactly like the session side.

Once at least one planner report exists,
`node evals/run.mjs --compare evals/planner/session-arm.json evals/planner/planner-arm.json`
reports the delta per indicator between what a session actually spent and
found against the same spec and what `faberun plan` would have.

`--validate-planner-arm --min <n>` fails (exit 1) unless at least `n`
campaigns qualify for the session side — proof there is enough closed session
material for the comparison to mean something, independent of whether any
planner report has been saved yet.

## Case format

Each case lives in its own directory under `evals/deterministic/<case-id>/`
and has:

- `case.json` — the scenario.
- `expected.json` — the facts the run must show at the end.
- one recording file per runtime the contract declares (referenced from
  `case.json`'s `recordings`), each a `.jsonl` file consumed in order by the
  `replay` harness (see `src/harnesses/replay/index.mjs`
  and `replay-bin.mjs` for the exact envelope schema).

A recorded envelope's `error.resetAt` and top-level `exhaustedUntil` are both
optional. `error.resetAt` may carry a relative placeholder — the string
`"+<milliseconds>"` — instead of an absolute timestamp. The `replay` binary
resolves it to a real ISO timestamp at the moment it emits the envelope, so
the controller receives exactly the shape a real harness would produce and the
window starts where the invocation ends, not where the case was materialized
(on a slow runner, repository setup alone outlasted a three-second window).
Use this for a case whose scenario turns on a reset landing inside a window
(see D04's `primary.jsonl`); an absolute timestamp works too when the exact
instant does not matter to the case.

A recording only stands in for a prompt invocation — the live version probe
(`probeRuntime`, run once per declared runtime whenever a contract leaves a
role's runtime to be composed) never touches it. A case whose scenario turns
on that probe's own classification (e.g. distinguishing an insufficient-
balance stop from a quota stop from a missing CLI) instead sets a runtime's
`config["replay.probe"]` to `{"exitCode": <int>, "stderr": "<text>"}`
directly in `case.json`; the replay harness carries it to `replay-bin.mjs` as
a `--replay-probe` argument for the `--version` invocation only, so it never
touches or consumes a recording (see D06).

### `case.json`

```jsonc
{
  "id": "D01",
  "title": "one line",
  "proves": "one sentence: what this case proves",
  "contract": { /* a complete, valid schemaVersion 3 contract */ },
  "recordings": { "<runtimeId>": "<recording-file>.jsonl" },
  "setup": [ /* optional, see below */ ],
  "discriminator": { /* required, see below */ }
}
```

`contract` is a full faberun contract (schemaVersion 3). Every
`runtimes` entry the contract declares must use `"harness": "replay"`; the
harness injects `config["replay.recording"]` itself, pointed at a fresh copy
of the recording named in `recordings` for that runtime id — do not set
`replay.recording` by hand in `case.json`. Omit `cwd`: the harness always
materializes the contract at the root of a fresh temporary git repository and
runs it there.

`setup` is an ordered list of steps executed before the run's final state is
compared to `expected.json`. When omitted (or empty), the harness runs
exactly one step: `{"type": "run"}`. A case whose scenario needs more than a
single clean run — a crash and its resume, a rejected concurrent resume,
deterministic filesystem preparation the `replay` harness cannot express on its
own — declares the full ordered sequence here, including the final step whose
resulting run directory is what gets compared to `expected.json`.

Step types:

| type | fields | effect |
|---|---|---|
| `run` | `env?`, `expectError?` | calls `runContract(contractPath)` |
| `resume` | `options?`, `env?`, `expectError?` | calls `resumeRun(runDir, options)` |
| `holdControllerLock` | — | acquires the run's `controller.lock` for this process, synthesizing a concurrent holder |
| `mkdirp` | `path` | `mkdirSync(path, {recursive: true})`, relative to the case workspace root |
| `writeFile` | `path`, `content` | writes a file, relative to the case workspace root |
| `writeLock` | `processStartToken?` | writes `controller.lock` directly (bypassing `acquire()`'s own exclusivity checks) for this process's own pid; `processStartToken` defaults to this process's real token (a genuinely live-looking lock) and may be overridden with any other string to plant a lock whose recorded token no longer matches the live process holding that pid — standing in for a controller pid later reused by an unrelated process |
| `rewindNodeToRunning` | `node` | rewrites `nodes/<node>.json` back to `status: "running"`, `phase: "worker"`, `result: null`, `gate: null`, keeping everything else (in particular `invocations`) — the same rewind `test/helpers.mjs`'s `orphan()` does, standing in for a controller that died with this node's invocation already finished on disk but never processed |
| `recreateAttemptWorktree` | `node` | when `nodes/<node>.json`'s `worktree.status` is `"removed"`, recreates that attempt's worktree on the existing attempt branch and updates the node's `worktree` to `"ready"` at the recreated path — the same recreation `test/helpers.mjs`'s `ensureAttemptWorktree()` does, needed before recovering an orphaned node whose prior integration already sealed and removed its worktree; a no-op otherwise |
| `preflight` | — | calls `preflightContract(contractPath, {static: true})` — the same static, no-model probe the `preflight` CLI command runs, one `probeRuntime` call per reachable runtime, including every candidate of a role a contract leaves for the factory to compose — and writes the returned array to `preflight.json` in the case workspace root. Unlike `run`/`resume`, this never throws when a reachable runtime cannot be probed; a case whose point is exactly that a bad runtime is classified, not that it blocks a run, uses this instead (see D06) |

`env` overlays environment variables for the duration of that one step only
(restored immediately after). `expectError` is a regular expression (string,
case-insensitive); when present, the step's call must reject with a message
matching it, or the case fails — this is how a case pins a crash without
needing a second field in `expected.json` to describe the rejection.

A case whose scenario is disk pressure never fills a real disk. `env` on a
`run`/`resume` step instead sets one or both of:

- `FABERUN_SIMULATE_ENOSPC_MATCH` / `FABERUN_SIMULATE_ENOSPC_COUNT`
  — the next `COUNT` run-directory writes whose path contains `MATCH` fail
  with a synthetic `ENOSPC` instead of actually writing (`disk-gc.mjs`'s
  `writeRunTextWithDiskPressureRetry`, the only write `writeNode` makes).
  `COUNT: "1"` proves a single ENOSPC recovers after one GC pass; `"2"`
  proves a second one in a row never gets a second retry.
- `FABERUN_SIMULATE_GC_ROUNDS` — deterministically bounds how many
  times the garbage collector's own "is there enough space now" check
  reports "not yet" before reporting "enough", standing in for real free
  space crossing the threshold. It never affects `environmentPreflight`'s own
  disk check, which always reads real free space. The count is calls, not
  removals: an eligible-run count of `n` needs `n + 1` to reclaim all of
  them (see D09).

### `discriminator`

Every case must declare a `discriminator`: one mutation that must make the
case fail. A case whose expected outcome does not actually depend on
whatever the mutation touches proves nothing — `--verify-discriminating`
catches that by requiring the mutated run to fail.

Every mutation is applied only in memory — to the normalized step list, to a
fresh in-memory clone of the contract, or to a recording only after it has
been copied into the case's temporary workspace — and never touches a file on
disk, versioned or otherwise.

| type | fields | effect |
|---|---|---|
| `removeSetupStep` | `indices` (non-empty array of step indices) | drops those steps before running the case |
| `patchContractField` | `path` (non-empty array of object keys / array indices), and either `value` or `remove: true` | sets, or deletes, one field of the materialized contract before the run |
| `patchRecordingErrorCode` | `runtime` (a key in the case's `recordings`), `code`, `index` (optional, defaults to `0`) | rewrites `envelope.error.code` on one line of that runtime's recording before it is copied into the workspace |
| `patchRecordingEnvelopeField` | `runtime` (a key in the case's `recordings`), `path` (non-empty array of keys relative to that line's `envelope`), `index` (optional, defaults to `0`), and either `value` or `remove: true` | sets, or deletes, one field of one recorded envelope (e.g. `["error", "resetAt"]`) before it is copied into the workspace |

Pick a mutation that, once applied, necessarily changes the run's outcome —
not merely one that happens to touch something that exists. If a declared
discriminator does not make its case fail, the case's `setup`, `contract`, or
`expected.json` is wrong and needs fixing; the discriminator requirement
itself does not bend.

`removeSetupStep` is rejected as invalid — not merely a failing mutation —
when it would remove every `run`/`resume` step from the case's setup. A case
with no step left to execute fails because nothing ran at all, not because of
whatever the case claims to prove, which would let `--verify-discriminating`
pass on a case that proves nothing. A case whose `setup` is a single `run`
step (the default for an omitted `setup`) can never use `removeSetupStep` for
this reason; reach for `patchContractField`, `patchRecordingErrorCode`, or
`patchRecordingEnvelopeField` instead, varying exactly the one value the
case's `proves` claim turns on.

### `expected.json`

```jsonc
{
  "nodes": {
    "<node-id>": {
      "status": "done",
      "errorCode": null,
      "revisions": 0,
      "runtimeIds": ["replay-worker"],
      "routingHistoryLength": 0,
      "integratedHead": true
    }
  },
  "integration": {
    "runRefMatchesIntegratedHead": ["<node-id>"],
    "acceptedRecords": [{ "node": "<node-id>", "attempt": 1 }],
    "worktreesAbsent": {
      "attempts": [{ "node": "<node-id>", "attempt": 1 }],
      "candidate": true
    }
  },
  "preflight": {
    "<runtime-id>": { "available": false, "exhaustedUntil": null, "reason": "insufficient_balance" }
  },
  "gc": {
    "removed": ["<run-id-removed-by-garbage-collection>"],
    "kept": ["<run-id-or-campaigns-that-must-survive>"],
    "events": [{ "path": "<run-id>", "reason": "enospc" }]
  }
}
```

Every field is optional; only what a case declares is checked. `nodes` fields
read directly off the node's persisted snapshot
(`.runs/<contractId>/nodes/<node-id>.json`) after every `setup` step has run:

- `status` — the node's terminal status.
- `errorCode` — `error.code`, or `null` when the node has no error.
- `revisions` — the revision counter.
- `runtimeIds` — `invocations[].runtimeId`, in order (worker and judge
  invocations together, in the order they actually ran).
- `routingHistoryLength` — the length of `routing.history` (fallback/backoff
  hops; a gate-triggered revision retry is not a hop and does not add to it).
- `integratedHead` — `true` requires a published sha (a non-null string),
  `false` requires `null`, and a string requires that exact sha.

`integration` checks facts that live outside any one node's snapshot — the
actual publication a resume or recovery claims to finish, not just the node's
own after-the-fact bookkeeping:

- `runRefMatchesIntegratedHead` — an array of node ids; for each, the run's
  git ref (`refs/faberun/<runId>/run`) must exist and equal that
  node's `integratedHead`.
- `acceptedRecords` — an array of `{node, attempt}`; each must have an
  `"accepted"` record in `integration.jsonl`.
- `worktreesAbsent.attempts` — an array of `{node, attempt}`; each attempt
  worktree must no longer exist on disk.
- `worktreesAbsent.candidate` — when `true`, the run's `.candidate` worktree
  must no longer exist on disk.

`preflight` checks a map from runtime id to that runtime's exact `availability`
entry (`{available, exhaustedUntil, reason}`) in the `preflight.json` a
`preflight` setup step wrote; only the named runtime ids are checked. A case
using this needs a `preflight` step in its `setup` — this section, not a
`nodes` entry, is how a case pins the live probe's own classification for a
runtime no `run`/`resume` step ever dispatches.

`gc` checks facts about `src/run/disk-gc.mjs`'s
disk-pressure garbage collector, which can remove (or must never remove) a
run directory no single node's own snapshot describes — there is no `nodes`
entry to check this against:

- `removed` — an array of run ids (the last path segment under `.runs/`);
  each must no longer exist on disk.
- `kept` — an array of run ids, or `"campaigns"`; each must still exist on
  disk. Always include the case's own current run id and `"campaigns"` here
  when the scenario puts pressure on the collector, since those are the two
  guards a regression would most plausibly break.
- `events` — an array of `{path, reason}`; each must match one line of
  `.runs/gc.jsonl` (`path` matched by suffix, `reason` matched exactly). A
  case proving GC actually reclaimed something, not merely that a retry
  happened to succeed, needs this: `removed` alone cannot tell a directory
  GC deleted from one that was simply never created (see D09, whose
  discriminator removes the setup steps that seed the reclaimable run and
  therefore leaves `gc.jsonl` never written at all).

## Command-kind cases

A case whose scenario is `faberun plan` itself — a command driven by argv, not
by a contract — carries `command: {argv, env?}` in `case.json` instead of
`contract`, and is materialized and run differently:

- `files` (a map from repo-relative path to text content) writes every
  fixture the planning pipeline reads — the spec, the taskKind catalogue at
  `src/plan/template.mjs`, anything a plan node's own `readFiles` names —
  into the same fresh temporary git repository a contract-kind case gets.
- `runtimes` is a runtime catalogue in the contract's own `runtimes` shape;
  `recordings` substitutes a `replay.recording` into it exactly the way a
  contract-kind case's `recordings` does. It is written to `runtimes.json` at
  the workspace root, which `command.argv` names after `--runtimes`.
- `campaign` (`{id, goal}`) is materialized with `initializeCampaign` before
  the command runs, since `faberun plan` requires an already-active campaign.
- `setup`, when present, is an ordered list of steps run instead of the
  default single `{"type": "invoke", argv: command.argv}` step. Every step
  spawns or waits on a real child process — `node src/cli.mjs <argv>` — rather
  than calling anything in-process, since proving a detached pipeline
  survives its launcher (D25) needs a launcher that is a genuinely separate,
  killable OS process. Step types: `invoke` (`argv`, `env?`; runs to
  completion), `spawnDetached` (`argv`, `env?`, `as`; spawns without waiting,
  keyed by name), `waitForPath` (`path`, `timeoutMs?`; polls for a workspace
  path to appear), `killProcess` (`as`, `signal?`; signals a process a prior
  `spawnDetached` step named, ESRCH ignored).
- `expected.json` checks `expectPaths` (`{present, absent}`, workspace-
  relative), `plan` (`{path, fields}`: JSON fields of a `plan.json` at a
  declared relative path), and `journal` (an array of `{type, questionId?}`
  entries that must appear in the campaign's journal) — the facts a `plan`
  invocation leaves behind, since there is no node snapshot to read most of a
  planning scenario off of.
- `discriminator` is restricted to `patchRecordingErrorCode` and
  `patchRecordingEnvelopeField` (the same two recording mutations a
  contract-kind case can use): there is no contract to patch, and no
  `removeSetupStep` that could shrink a command case's setup without also
  erasing the invocation itself.

`--assert-no-model`, `--verify-discriminating`, `--verify-fixtures` and
`--validate-golden` all treat a command-kind case the same as a contract-kind
one; see D23, D24 and D25 for worked examples.

## Adding a case

1. Pick the next case id and create `evals/deterministic/<id>/`.
2. Write `case.json` with a minimal contract that proves exactly one thing.
   Prefer the simplest scenario that reaches the code path under test — most
   cases need only a single `run` step with no `setup` at all.
3. Write one recording file per runtime (envelopes must carry every field the
   schema requires: `status`, `result`, `continuationId`, `usage`, `costUsd`,
   `error`; add `files` for the envelope to also write into the workspace).
4. Write `expected.json` with only the fields the case actually needs to
   prove its point.
5. Write a `discriminator` (see above) and confirm with
   `node evals/run.mjs --class deterministic --case <id> --verify-discriminating`
   that the mutation it names actually makes the case fail. If it does not,
   `expected.json` is not checking what the case claims to prove — fix the
   case, not the discriminator.
6. Run `node evals/run.mjs --class deterministic --case <id> --json` and
   confirm it passes; then run the whole class to confirm you have not
   broken anything else.
7. If the scenario is expressible only partly through `replay` (it needs real
   filesystem or git state `replay` cannot produce), use `setup` for the rest
   and say exactly what is synthesized in `proves` — never invent a fake
   model response to stand in for a scenario `replay` cannot express.

## Golden set

```
node evals/build-golden.mjs
node evals/run.mjs --validate-golden --min <n> [--json]
node evals/run.mjs --verify-fixtures [--json]
```

`evals/golden/<task-id>/` holds one task per real commit in this
repository's own history — never a hand-written scenario. `build-golden.mjs`
(re)builds the whole directory from git plumbing: a curated list of commits
the faberun itself integrated into `main` (see
`docs/history/TECH-SPEC-2026-09-09.md` §C1.3), plus every `fix`
commit whose own diff touches both the source and the test tree (the paths as
they were at that commit) in the same commit — a correction landed together with the test that pins
it, discovered by walking `main`, not picked by hand.

Each task directory has:

- `statement.md` — the node's original `taskPacket`, read verbatim from
  `.runs/<runId>/contract.json` when that run directory still exists, or
  (almost always, since old runs get pruned) the commit's own message,
  untouched. Never rewritten: a later paraphrase of what the task asked for
  would contaminate any measurement run against it.
- `verify.json` — `{source, commands}`. `source: "taskPacket"` when the
  node's own declared `verification` survived in `contract.json`;
  otherwise `source: "diff"` and `commands` is derived mechanically from the
  commit's own diff — `node --check <file>` for every non-test `.mjs` file
  it touches, `node --test <file>` for every `*.test.mjs` file it touches.
  Every command is the same `{argv, ...}` shape
  `validateVerificationCommands` (`src/contract/verification.mjs`)
  already enforces on a real contract.
- `meta.json` — `commitSha`, `parentSha`, `parentTreeSha` (the parent
  commit's git tree id, what `--verify-fixtures` checks the bundle against),
  and, when a run directory survived to report them, `runtimeOriginal`,
  `costUsdOriginal`, `wallClockSecOriginal` — `null`, never `0`, when
  unknown.

Every task's parent commit lives in the single shared
`evals/golden/fixtures.bundle` instead of a `fixture.bundle` per task: the
parent commits share most of their ancestry, so one bundle covering all of
them packs to roughly a twenty-fifth the size of one shallow bundle per
task repeated.

- `--validate-golden --min <n>` fails if there are fewer than `n` task
  directories, if any is missing `statement.md`/`verify.json`/`meta.json`,
  or if `verify.json`'s commands do not validate as a real verification-command
  list.
- `--verify-fixtures` fetches each task's `parentSha` from the bundle into a
  throwaway bare repository and compares the restored tree id against
  `meta.json`'s `parentTreeSha`, failing loudly if any task does not
  restore or the tree does not match.
