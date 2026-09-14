# Spec v7: factory-autonomy-20260914 (campaign 1 of 2)

Campaign 1 carries the operator-loop half of
`skills/mine/intent-factory/docs/REVIEW-2026-09-14-operator-loop.md`, **as
corrected at commits `4585f5d` and `c7ae865`** — round 3 of adversarial review found four
stale citations in the original, the review's author verified and corrected
each inline, and this spec cites the corrected text throughout. Campaign 2,
named at the end, carries the ergonomics half.

Target: /Users/frb/dev/frb/skills, skills/mine/intent-factory. Node 22, plain
ESM `.mjs`, JSDoc-typed, no runtime dependencies.

## Why this order, and what the numbers actually say

The review measured 163 run directories — 43 succeeded, 22 canceled, 93
parked, 5 unfinished; the three largest idle gaps (8h49, 5h45, 4h38) sit behind a dead or
parked run rather than a model in flight; and `controller.lastTick` is `null`
in 47 of 47 `status.json` files, so a dead controller and a working one are
indistinguishable on disk.

**The dependency figure, with both its set and its field declared.**
`dependency_failed` is **140 of 291 error-bearing events, 48.1%**, over
**every `events.jsonl` under `.runs/` except `worktrees/` (163 files)**,
counting the `error` field. Two earlier figures were wrong and are recorded
here so the correction is not relitigated: 52% came from a subtotal the source
never defined, and 47.1% mixed a numerator from a 162-file set with a
denominator from the 163-file set while also conflating the `error` field with
`errorCode`. Five lines in those files are node snapshots rather than
transitions — they carry `schemaVersion` and `packetHash` and report
`errorCode` — and are excluded. The thesis is untouched: still the largest
single code by roughly six times, with the runner-up (`provider_error`) at 23.

**Run outcomes, classified by node status rather than by last event.** Of 163
runs: **43 succeeded, 22 canceled, 93 parked, 5 unfinished**; 26 of the 93
have every node `blocked`. An earlier draft said "79 non-terminal, 73 of those
blocked", which reproduces under no stated definition.

Two retrospective claims from the preceding campaign were checked and do not
survive; neither is built on. "Preflight never checks credentials" is false
(`probeRuntime` returns `{available: false, reason: "authentication_required"}`
and the renderer prints it). And the preceding campaign's shrunken runtime
pool happened at `resume`, not at run creation — pool reporting moves to
campaign 2 and is scoped there honestly.

## Phase 1 — a heartbeat, and a supervisor that reads it

**Problem, cited.** `superviseRun` relaunches only when
`progress.state === "unfinished" && !controllerAlive(runDir)`
(`supervise.mjs:136-138`); `controllerAlive` is lock liveness alone (`:104`).
`render.mjs:313-318` hard-codes `lastTick: null` while the lock is live and
computes it only once the lock is already stale. `lifecycle.mjs:123-133`
computes `livenessState()` and has no production caller.

**Change.** `driveRun` writes `<run-dir>/heartbeat.json` with exactly these
fields:

- `at` — the loop process is alive. Written by an **unref'd `setInterval`**,
  never by the loop body. Threshold: `2 × interval`.
- `lastProgressAt` — work advanced: a node state transition or provider
  output. Written **by the loop**. Threshold: the derived budget below.
- `iteration` — monotonic loop counter.
- `activeNodes` — an **array of objects**, not a list of ids and not a single
  node: each element is `{nodeId, lastProgressAt, budgetBasis}`, carrying that
  node's **own** last-progress instant and the budget it is judged against.
  This is not cosmetic. With only the global `lastProgressAt` and a run
  threshold taken as the maximum across active nodes, a healthy sibling
  refreshing the global timestamp would keep that threshold unbreached
  forever, and a frozen node could never be detected — the concurrency case
  below would be unsatisfiable by the very mechanism this phase specifies.
  The supervisor therefore judges **per node**: an element whose own
  `lastProgressAt` exceeds its own `budgetBasis` is a breach even while the
  run's global timestamp is fresh.

**What a per-node breach does.** Relaunching kills the controller, and with it
the healthy sibling. That is intended and stated rather than left to the
implementer: the run is relaunched as a whole. What happens to the healthy node is
adoption, not sealing: workers run detached in their own process groups, so
killing the controller does not kill them, and the next `resume` **adopts**
that invocation through its recovery pass while it is alive and inside its
deadline, re-dispatching only when it is not. (Sealing before a kill does not
exist until phase 5b, so nothing here may lean on it.) Killing one job inside
a live controller is a larger change this phase does not make.

The split between `at` and `lastProgressAt` is load-bearing: the loop awaits
verification on its own critical path (`lifecycle.mjs:442`), so a heartbeat
written only by the loop stops during a legitimate 600 s verification and a
supervisor reading that single field would kill a healthy controller.
Conversely a child that never closes keeps the process alive while work stops
— `at` fresh, `lastProgressAt` stale — which is precisely what
`lastProgressAt` exists to catch.

**The derived budget, defined rather than gestured at.** Per active node:
its `timeoutSec`, plus the sum of its verification commands' `timeoutSec`
**including each command's `repeat` count**, plus candidate verification,
plus gate commands, plus the contract's `finalVerification` when that node is
phase-terminal. With several nodes active, the run's threshold is the
**maximum** across active nodes, not the sum and not a global constant.

**Recovery is a bounded state, not progress.** `resume`'s orphan adoption
busy-waits per orphan (`recover.mjs:103-115`) before the drive loop begins.
Refreshing `lastProgressAt` on each poll would be wrong in the other
direction: an orphan that is alive but never advancing would look like
perpetual progress. Instead the heartbeat carries an explicit bounded state —
`phase: "recovering"` with `until: <the orphan invocation's own deadlineAt>`,
the same bound `recover.mjs:103` already busy-waits against. While
`recovering`, the supervisor judges against `until + grace`, not
`lastProgressAt`, and the adoption poll **never touches `lastProgressAt`**.
A controller resuming within its deadline is safe; an orphan that never
advances dies at the deadline it already had.

**Relaunch, bounded and durable.** `superviseRun` treats either threshold
breach as a dead controller **even with a live lock**: terminate the
controller's process group — bounded, `SIGTERM` then `SIGKILL` after a named
grace, and only then take the lock — and relaunch. After **two consecutive
relaunches with no `lastProgressAt` advance between them**, the run parks with
`attention` and `controller_unresponsive` rather than a third kill. That
counter is persisted in `run.json`, not held in memory: an in-memory counter
resets whenever the supervisor itself restarts, which turns the guard into an
endless dispatch storm. `render.mjs` reads `lastTick` from the heartbeat.

**Done when:**
1. the heartbeat carries `at`, `lastProgressAt`, `iteration` and
   `activeNodes`, and `at` keeps advancing across a verification that occupies
   the loop longer than `2 × interval` — proving `at` is not loop-written.
2. a stale `at` with a live lock terminates the group and relaunches; a fresh
   `at` with a live lock does nothing.
3. a fresh `at` with `lastProgressAt` beyond the derived budget is treated as
   dead — the frozen-child case the first threshold cannot catch.
4. a node in a legitimate verification longer than `2 × interval`, with
   `lastProgressAt` inside its derived budget, is **not** relaunched.
5. **concurrency:** one node producing output while a sibling is frozen still
   detects the frozen sibling, by that sibling's own element exceeding its own
   `budgetBasis` while the run's global `lastProgressAt` stays fresh — the
   case a singular `activeNode`, or a run-level maximum, could never catch.
   The relaunch that follows kills the controller; the test asserts that the
   healthy sibling's still-live invocation is **adopted** by the next
   `resume`'s recovery pass rather than re-dispatched, and that it is
   re-dispatched only once its deadline has passed.
6. the derived budget accounts for a verification command with `repeat > 1`
   and for `finalVerification` on a phase-terminal node.
7. during `phase: "recovering"`, a controller inside `until + grace` is not
   killed; one beyond it is; and the adoption poll never advances
   `lastProgressAt`.
8. two consecutive relaunches with no progress advance park the run with
   `controller_unresponsive`; the counter survives a supervisor restart,
   asserted by reading `run.json`.
9. termination is bounded: `SIGTERM`, then `SIGKILL` after the named grace,
   and the lock is taken only after the group is gone.
10. `status` reports a real `lastTick`, where 47 of 47 recorded files report
    `null`.
11. every threshold is driven by a fake clock; no test waits on real time.

## Phase 2 — parked, not finished (and a persisted run stays loadable)

**Problem, cited.** `prompts.mjs:8-16` puts every parked status in `TERMINAL`,
so `supervise.mjs:87` counts the node terminal and `:132-134` reports the run
`done` and returns: the watchdog sees a parked run as a finished one.
`notify-queue.mjs:49-61` dedupes forever, so attention fires once and never
again. `dependency_failed` is 140 of 291 error-bearing events.

### 2.1 — a persisted load is pure (this sub-phase goes first)

`contract validate .runs/followup-phase1-20260914/contract.json` exits 1 today
with four cross-node findings, because the scope-closure refusal
(`contract/index.mjs:294-318`) runs on every load. `resume` takes that same
path at `resume.mjs:103` and throws before touching state, so **a run whose
contract no longer closes against the current tree cannot be resumed at all**
— and phase 2's entire remedy for a parked run is "re-nag until a `resume`
clears it".

**The mechanism, stated correctly.** An earlier draft blamed a node creating a
test file *during* its run. That is wrong: the scope detectors read the
operator's `cwd` working tree and explicitly skip `.runs`
(`repo/scope-closure.mjs:62`), where attempt worktrees live, and never read
`gitHead` or a run ref. A node's new file is invisible to them mid-run. It
becomes visible only once that work **lands in the operator's tree** — which
is exactly what happened to `followup-phase1-20260914`: an earlier phase's
landed `routing.test.mjs` is what now trips its persisted contract. The break
is post-landing drift, and the fixture must simulate that rather than a
mid-run write.

**The problem is wider than the scope detectors, and an earlier draft of this
spec got that wrong.** Skipping only the tree-reading *scope* checks would
still leave a persisted load dependent on the mutated live tree. Two facts,
both verified this round and both stated here as claims to check rather than
as settled:

- `options.persisted` is **declared and never consulted**. It appears exactly
  twice in `contract/index.mjs`: the JSDoc type at line 91 and a comment at
  line 300. No code reads it. Every caller that passes `{persisted: true}` —
  `resume.mjs:103`, `render.mjs:456`, `cancel.mjs:36`, `launch.mjs:150` — is
  therefore passing a flag that does nothing.
- The tree-reading surface inside validation is broad: `src/contract/*.mjs`
  holds 23 filesystem-read call sites. Beyond scope closure they include
  `readFiles` existence (`task-packet.mjs:296-303`), `writeRoots` anchors
  (`:259-262`), realpath and symlink checks (`:249-255`, `:281-289`,
  `:317-322`, `:340-358`), verification `cwd` (`verification.mjs:79-85`),
  `contract.cwd` as a directory (`index.mjs:104`), `writeRoot` as a file
  (`index.mjs:511`), and the ignore probes in `repo/declared-paths.mjs:77`
  and `:102`.

So a run whose node deleted or moved a `readFile`, or whose `writeRoot` became
a symlink, stays unresumable even if the scope detectors are skipped. The
four cross-node findings were one instance of a larger class.

**Change: a persisted load is pure.** With `persisted: true`,
`validateContract` touches the filesystem for nothing beyond reading the
`contract.json` it was handed. Every tree-dependent decision was made at
creation and is frozen by the two records below. Callers that genuinely need
the tree do their own preflight *outside* validation — `resume` already checks
that `HEAD` descends from `gitHead`, and the chain's launch of N+1 does its
own.

The justification is not that `packetHash` proves the contract — it does not:
it covers the task packet alone (`repo/source-identity.mjs:71`, hashed at
`contract/index.mjs:346-348`) and says
nothing about the DAG, gates, runtime selection, timeouts, definition of done
or final verification. Nor is it that re-evaluation cannot produce new
information — it can, since a test one node created may now import a path
another node owns. It is that **a replay must use the contract and the scope
decision frozen at launch, rather than reinterpret history against a mutated
tree.**

Run creation therefore persists both, in `run.json`:

- `contractDigest` — canonical JSON of the **validated** contract, minus
  `sourceIdentity`, minus `warnings`, minus absolute paths (`cwd`), so the
  same contract judged from another checkout still matches itself.
- `scopeDecision` — `{at, base: gitHead, dirtyTreeFingerprint}`, the
  successful authoring-time scope decision.

A persisted load verifies `contractDigest` against the stored `contract.json`
and performs no tree access at all. Authoring-time validation is untouched.
`contract validate` currently calls `validateContract()` with no persisted
option (`cli/contract.mjs`), so the CLI must be wired to take this path.

`contractDigest` lives here, not in phase 3, because phase 2.2 needs it first;
phase 3 consumes it.

**Done when (2.1):**
1. a fixture reproducing the real shape — **landed drift in the `cwd` tree**:
   a file that arrived after the contract was authored, plus an existing
   test whose imports changed — loads without a scope refusal, where it fails
   today.
2. **`resume` on that fixture proceeds** instead of throwing at
   `resume.mjs:103`.
3. `status` on it renders its node table, with no pre-rendered `STATUS.md`
   present to mask the failure.
4. **the wider class:** a fixture where, after the run, a declared `readFile`
   was deleted, a `writeRoot` became a symlink, and a verification's `cwd` no
   longer exists — `status` and `resume` both still load it. Skipping only the
   scope detectors fails this case.
5. **purity, asserted structurally:** with `node:fs` mocked to throw on any
   call other than reading the handed `contract.json`, a persisted load
   succeeds. This is what stops an implementation from exempting only the
   paths the other cases happen to cover.
6. **tampering:** a persisted contract whose DAG, gate, or runtime selection
   changed while every `packetHash` stayed identical is **rejected** — the
   case a packet-hash-based argument would wrongly accept. Likewise for
   changed timeouts, changed definition of done, and changed
   `finalVerification`.
7. the same contract loaded **not** persisted still rejects a non-existent
   `readFile` with today's exact message; and a contract that has not run,
   whose cross-node conflict exists only in an uncommitted working-tree file,
   is still rejected at authoring time with today's exact message — proving
   authoring reads the live tree and that the persisted path did not become a
   blanket exemption.
8. `contractDigest` and `scopeDecision` are present in `run.json` after
   creation and survive both a `resume` and a heartbeat relaunch, asserted by
   reading `run.json` after each — `driveRun()` rewrites run metadata
   (`scheduler.mjs:178`).

### 2.2 — the outcome reduction and the parked state

*Run outcome.* `runProgress` answers only "is anything still moving": it
returns `done` for any all-terminal set, whatever those statuses were. Add
`runOutcome: "succeeded" | "parked" | "waiting" | "canceled"`, reduced
**against the validated contract's own node set**: `succeeded` requires a readable snapshot
for every node the contract declares, each in `{done, no-op}`. "Non-empty and
all successful" would accept one `done` snapshot from a three-node contract —
exactly what a crashed bootstrap leaves behind. `canceled` is determined from
a **durable run-level cancellation marker**, never inferred from any node
happening to be `canceled`. `waiting` when the only thing keeping the run from terminal is a node
`blocked` with `error.code: runtime_tier_exhausted` whose recorded reset is
still in the future — the shape `runProgress` already returns today, with its
`waitingUntil` (`supervise.mjs:73-92`), including the edge where the reset
arrives and it becomes ordinary unfinished work. Without this fourth value the
reduction would park exactly the run phase 3 requires it not to park, and
`waiting` would exist only in phase 3's prose. `parked` otherwise, naming
every non-success node with its status; a node whose snapshot is missing or
unreadable is named as such rather than silently dropped.

Because the reduction must load the contract and `runProgress`'s caller
(`supervise.mjs`) receives only a run directory today, this phase's write
scope includes the contract-loading path in `supervise` — and that load is a
persisted load, which is why 2.1 comes first.

*`TERMINAL` splits.* Terminal is `{done, no-op, canceled}`; parked is
`{blocked, failed, exhausted, stalled}`. `supervise` reports `attention`
separately from `done` and keeps ticking.

**Scope, enumerated, because this is where the phase will stop if it stops.**
Every reader of `TERMINAL` must be accounted for before `writeFiles` closes:
`engine/scheduler.mjs`, `engine/supervise.mjs`, `engine/assignment.mjs`
(`blockDependents`), `engine/lifecycle.mjs`, `engine/prompts.mjs`,
`engine/cancel.mjs`, `engine/resume.mjs`, `engine/scope.mjs`,
`engine/state.mjs`, `cli/launch.mjs`, `repo/signal.mjs`, `run/disk-gc.mjs`,
plus the local status sets in campaign and web code.

**`report/render.mjs` is a different and worse case, and belongs in the same
sweep.** It holds **zero** references to the shared set; what it has is
divergent inline lists. `render.mjs:124` treats
`["done","no-op","failed","exhausted","canceled"]` as terminal for elapsed
formatting — omitting `blocked` and `stalled`, so **a parked node's elapsed
clock keeps running today** — while `:107` and `:219`/`:243`/`:245` use inline
`["done","no-op"]`. A split that reaches only the importers of `TERMINAL`
leaves these untouched and silently inconsistent, so the sweep is defined over
divergent inline lists as well as set imports.
**`repo/integrate.mjs` has its own, unrelated transaction-status `TERMINAL`
and must not be split.** The preceding campaign's one out-of-scope write was
exactly this class of miss.

*Escalating re-nag.* Attention re-emits at 10 min, 1 h, 4 h, and **every 4 h
thereafter**, until a `resume` clears it or the campaign closes;
`notify-queue.mjs` keys its dedupe on the schedule slot. "A `resume` clears
it" means a resume that actually changed node state — a resume that fails
before changing anything must not silence future attention.

*One automatic retry.* Before parking, a node whose remedy is literally *try
again* gets exactly one automatic retry: `judge_unavailable`,
`provider_error`, and `stall_timeout` **and `wall_clock_timeout`** when the
attempt seal is non-empty. Both timeout codes are included because phase 5b
seals before killing, and the review's recorded 58-minute loss was a
`wall_clock_timeout`; an empty seal parks in both cases. The retry is on the
**same runtime**, carries its own event code `auto_retry`, does not count as a
gate revision, and its consumption is **persisted in `run.json`** — otherwise
every controller restart grants a fresh "exactly one" retry.

*Order against failover.* `provider_error` is not in `NETWORK_CODES`
(`backoff.mjs:61-64`), though message-based classification can still route
some instances through network handling, so the rule is stated on the code
rather than on the set: `auto_retry` on the same runtime first; on the second
failure today's failover logic runs unchanged, taking its hop; then park. An
error carrying a quota reset takes no `auto_retry`.

*Dependants.* A dependant of a node that still has its retry stays `pending`
with `phase: "waiting"` — the phase that already exists
(`contract/index.mjs:57`, and `scheduler.mjs:120` already creates dependants
that way). **No new node status**, which would move `status.json`'s
`schemaVersion` and every reader of it. What changes is *when*: the single
`blockDependents` call (`scheduler.mjs:315`, the only call site) is deferred
until the parent parks.

**Done when (2.2):**
1. a run whose nodes are all terminal but not all successful reports `parked`,
   naming each non-success node and status, where `runProgress` reports
   `done` today.
2. a run mixing `done` and `no-op` reports `succeeded`; a run whose only
   non-terminal node is `blocked`/`runtime_tier_exhausted` with a future reset
   reports `waiting` with its `waitingUntil`, and reports ordinary unfinished
   work once a fake clock passes that instant — not `parked`.
3. **sparse run:** a three-node contract whose run directory holds one `done`
   snapshot does **not** report `succeeded`.
4. a corrupt or unreadable snapshot is named in the parked report, not
   silently dropped; a mixed `done`/`canceled` run reports `canceled` from the
   durable run-level marker, not from the node status.
5. the empty-node case is asserted as a reducer unit invariant, with a
   separate test that contract validation already rejects an empty node set —
   the two are different claims and validation owns the second.
6. `supervise` on a parked run reports `attention`, keeps ticking, and does
   not return as today.
7. attention re-emits at 10 min, 1 h, 4 h and every 4 h thereafter on a fake
   clock, survives a supervisor restart, and stops only on a resume that
   changed state — a resume that fails before changing state does not silence
   it.
8. `judge_unavailable` and `provider_error` each get exactly one `auto_retry`
   before parking; every code parks immediately when the seal is empty. The
   two timeout codes' **positive** cases live in 5b.4, not here: until 5b
   lands, nothing seals before the kill (`process.mjs:305-341` calls
   `sealAttempt` nowhere), so a positive case at this phase could only pass
   against a hand-fabricated seal.
9. `auto_retry` consumption survives a controller restart, asserted by reading
   `run.json`: a restarted controller does not grant a second one.
10. `provider_error`: `auto_retry`, then today's failover hop unchanged, then
    park — asserted in that order; an error carrying a quota reset takes no
    `auto_retry`.
11. `auto_retry` increments neither the gate revision counter nor the failover
    hop counter.
12. a dependant of a node that still has its retry stays `pending` with
    `phase: "waiting"` — `status.json`'s `schemaVersion` unchanged — and
    becomes `dependency_failed` only once the parent parks.
13. every `TERMINAL` reader enumerated above behaves correctly after the
    split, with a named test per reader; `repo/integrate.mjs`'s own
    transaction `TERMINAL` is proven unchanged.
13b. `report/render.mjs`'s inline lists are reconciled: a parked node's
    elapsed clock **stops**, where `render.mjs:124` lets it run today.
14. a parked node is not overwritten by scope processing, is not
    garbage-collected as completed, and has defined cancel behaviour — one
    test each.

## Phase 3 — the chain: a terminal phase launches the next, on the previous one's work

**Problem, cited.** `run` and `supervise` each take one positional target
(`cli.mjs`); `runProgress` reads one run directory; campaign state
(`campaign/index.mjs:18`) knows only runs already registered, with no ordered
future contracts and no landing branch. The preceding campaign's phase 1 sat
terminal about two hours waiting for a human to answer an integration
question.

**Where the ordered list comes from, and when each contract is validated.** A
campaign cannot discover contract N+1 today, so this phase defines it: the
campaign record gains an ordered `contracts` array and a `landBranch`. The
chain reads that manifest; it does not infer order from the filesystem.

**Validation of N+1 happens at launch, not when the manifest is written, and
that is forced by the deferral rule.** A `readFiles` entry must exist at
validation time, and the deferral that allows a missing read applies only
*within* one contract, when a dependency of the same contract declares the
path in its `writeFiles`. There is no deferral **between** contracts. This
campaign is full of exactly that shape: phase 6 reads the inbox module phase 4
creates, phase 5b reads the hook phase 5a introduces, phase 3 reads the
`runOutcome` phase 2.2 adds. Validating every manifest entry up front would
reject each of them before its predecessor had run.

So the manifest entry carries the digest of N+1's **authored bytes** — enough
to detect tampering between authoring and launch — and N+1 is **fully
validated at the moment the chain launches it**, against the `landBranch` that
N's promotion just advanced, where the files N created now exist. The
`contractDigest` of the *validated* contract is still written to `run.json` at
run creation, exactly as phase 2.1 defines; the two digests answer different
questions and both are kept.

**The watchdog, and the process boundary this requires.** A frozen process
cannot detect its own freeze: an unref'd timer inside it stops too. So the
chain cannot be its own watchdog, and an earlier draft's requirement that it
be one is withdrawn. The architecture is an **idempotent re-invocation**, not
a resident daemon: `supervise campaign <id>` takes a `coordinator.lock` on the
campaign and writes `heartbeat.json` in the campaign directory. A second
invocation either finds a fresh heartbeat and **exits 0 having written
nothing**, or finds a stale one, terminates that process group and takes over,
or finds no coordinator and becomes it. The re-invoker is the host scheduler
(launchd or cron) or the operator session's own Monitor — the same pattern the repository's root
`README.md:38` already prescribes for run-level `supervise` — *"a built-in
`supervise` watchdog that keeps resuming a dead controller until the run is
terminal — from any host scheduler (launchd, cron, CI, or another agent)"* —
and the launchd line is documented in `SKILL.md`, where no such line exists
today.

**Three design rules.**

1. **Promotion, or N+1 runs against a tree without N's work.** A completed run
   advances only `refs/intent-factory/<run-id>/run` (`repo/integrate.mjs:324`);
   no branch moves. The chain launches N+1 only after N's `finalVerification`
   is green **and** the run's ref fast-forwards onto `landBranch`. Default
   `landBranch` is `campaign/<campaignId>`, created at the first run's
   `gitHead` when absent, and **never `main`**: landing on `main` requires an
   explicit operator flag. A non-fast-forward stops the chain; the chain never
   force-updates. Promotion is **idempotent and durable**: a crash after the
   branch moved but before campaign state recorded it must, on re-invocation,
   recognise the promotion rather than repeat or contradict it. If
   `landBranch` is checked out in the operator's tree or another worktree, the
   chain refuses rather than silently moving a ref under a live checkout.
2. **N+1's controller runs from the same controller snapshot as N.** This
   campaign edits the factory itself; launching N+1 from code N just landed
   runs unproven code in production. `run.json` records no controller identity
   today (`schemaVersion`, `contractVersion`, `pid`, `processStartToken`,
   `startedAt`, `sourceIdentity`, `integrationRef`), so it gains
   `controllerIdentity`. A path plus SHA is not enough on its own: re-issue
   must **verify the executable snapshot still matches that SHA**, and how the
   snapshot is created and frozen is part of this phase. Refreshing it stays a
   declared human boundary.
3. **Never edit the target tree while a run is active.** Requiring `HEAD` to
   be the promoted `landBranch` would force the operator's checkout onto that
   branch — the tree the rule protects. Instead `run` gains
   `--base-ref <ref>`: today it derives `gitHead` from the `cwd`'s `HEAD`
   (`repo/source-identity.mjs:69`, `:108`) with no way to be told otherwise.
   The run's source identity records that ref's sha, and the run ref and every
   attempt worktree are cut from it, so the operator's tree is never touched.
   A dirty tree blocks the launch only when the `cwd`'s `HEAD` *is* the base.

**Change.** The chain advances only on `runOutcome: "succeeded"`; any other
outcome parks the campaign with `attention` and stops. `waiting` is defined in
phase 2.2's fourth `runOutcome` value, which the chain
**consumes rather than defines**: a run reporting `waiting` is neither
advanced nor parked. An earlier draft left `waiting` in phase-3 prose only,
which would have had phase 2 park exactly the run phase 3 requires it not to
park.
Restart identity is `contractDigest` (phase 2.1), not packet hashes: re-issuing
skips a contract whose run already succeeded only when the digests match.

**Done when:**
1. three contracts whose runs all succeed launch in order and fast-forward
   `landBranch` after each — asserting the branch moved, not merely that three
   runs exist.
2. **lineage:** contract N+1's recorded `sourceIdentity.gitHead` equals the
   commit N's run integrated.
3. a second run that is `parked` stops the chain before the third, parks the
   campaign with `attention`, and names that contract, node and status.
4. a run whose `finalVerification` is red is not promoted even with every node
   `done`.
5. `landBranch` defaults to `campaign/<campaignId>`, created at the first run's
   `gitHead` when absent; `main` without the explicit flag refuses; a
   non-fast-forward refuses. One case each, with their own messages.
6. a `landBranch` checked out in another worktree refuses rather than moving.
7. promotion is idempotent: a crash after the branch moved but before campaign
   state recorded it, then a re-invocation, leaves one promotion and a
   consistent record.
8. `run.json` records `controllerIdentity`, N+1 launches from the same
   snapshot as N, and a snapshot whose executable no longer matches its
   recorded SHA refuses.
9. `run --base-ref <ref>` cuts the run ref and attempt worktrees from that ref,
   records its sha, and leaves the operator's working tree untouched —
   asserted on the tree. A dirty tree refuses only when the `cwd`'s `HEAD` is
   the base.
10. **the watchdog:** a second `supervise campaign <id>` against a fresh
    heartbeat exits 0 having written nothing; against a stale heartbeat it
    terminates the group and takes over; with no coordinator it becomes one.
11. a first run in the real waiting shape — `blocked`,
    `runtime_tier_exhausted`, future reset — does not advance the chain and is
    not a failure; once a fake clock passes the reset and it succeeds, the
    chain advances.
11b. a contract N+1 whose `readFiles` names a file that only N creates
    **validates and launches after N's promotion**, and is refused if
    launched before it — the case that decides whether this campaign can chain
    itself at all.
11c. a manifest entry whose authored bytes changed between authoring and
    launch stops the chain with a tamper report, distinct from the
    validated-contract digest mismatch below.
12. re-issue with a changed `contractDigest` stops with a mismatch report,
    including when every `packetHash` is unchanged but the DAG, gate, runtime
    selection, timeouts, definition of done or `finalVerification` changed.
13. re-issue whose runs already succeeded launches only the remainder;
    re-issue while the current run is non-terminal awaits rather than
    relaunching.
14. the chain writes no node state and takes no run lock — asserted so as to
    separate the chain's own behaviour from the child controllers' legitimate
    writes; a global spy would observe the children and prove nothing.
15. every case runs through the real CLI surface, with its exact syntax
    including the `main` authorization flag.

## Phase 4 — say something useful to the next session

**Problem, restated correctly.** An earlier draft said the managed block is
rewritten only by `campaign init`/`close`. That is false: `syncAgentSignal` is
called from `scheduler.mjs:148` and `:150` (creation and terminal transition),
`cancel.mjs:109`, and `resume.mjs:498`. The real defect is **what the block
says**: `repo/signal.mjs:24-60` renders unclosed campaigns and runs holding a
non-terminal node, so a run that parked — every node `blocked` — **disappears
from the block entirely**, and a session reading it learns nothing. The
`noTransport` default (`notify/index.mjs:112-113`) and the false three-retry
promise in `operations.md:129-131` are real and unchanged.

**Change.** With phase 2's `runOutcome` available, the managed block renders,
per linked run of an active campaign: `parked` with its nodes, their codes and
the exact `resume` command; `succeeded` as one line; plus the most recent
`attention` entry. `.runs/inbox.jsonl` is **created** by this phase as the append-only record the
block summarises — it does not exist today — with a declared schema, a declared dedupe key, and declared
concurrent-append behaviour. `campaign watch --wake` gains `--detach` and
routes through the notify queue — and because that queue is run-directory
scoped today while a campaign watcher can emit with no run active, this phase
defines where campaign-level notifications are queued. Two detached watchers
must not double-send, so duplicate-watch prevention is durable, not
in-process. **No default transport is introduced, and an earlier draft that proposed one
is withdrawn.** There is no default on any platform: unset resolves to
`noTransport` (`notify/index.mjs:111-113`), and that is a documented decision,
not an oversight — `notify/index.mjs:13` states
`INTENT_FACTORY_NOTIFY_BIN=os-macos` is *"an explicit opt-in, never a
default"*. Defaulting it would reverse that decision, so the gap is closed
without touching it: `doctor` and `preflight` emit a named warning when the
variable is empty — no human transport is configured, so terminal events
reach only the inbox and the managed block — and the **foreground** launch
command (`run --detach`, `supervise`) prints the same warning once, since that
is the only moment an operator is present. The detached controller prints
nothing, because its stdio is discarded. Note also that no adapter anywhere is
wake-capable (`os-macos.mjs` declares `canWake: false`), so `--wake` against
such a transport must say so plainly rather than imply a session was woken;
the channel that actually reaches the next session is the managed block and
the inbox, which depend on no transport at all.
`references/operations.md:129-131` is corrected to describe what
`notify/index.mjs` actually does: the three-retry-with-backoff promise is
false — the code makes exactly one attempt, and `INTENT_FACTORY_NOTIFY_BACKOFF_MS`
appears nowhere in `src`.

**Done when:**
1. a run that parked appears in the managed block with its nodes, codes and
   `resume` command — where today it disappears.
2. a succeeded run renders as one line; the most recent `attention` entry
   renders.
3. `.runs/inbox.jsonl` entries match the declared schema, dedupe on the
   declared key, and survive concurrent appends from two writers.
4. campaign-level notifications are queued and delivered with no run active.
5. two detached `campaign watch --wake --detach` processes deliver each line
   once, proven across a restart of one of them.
6. with `INTENT_FACTORY_NOTIFY_BIN` unset, `doctor` and `preflight` emit the
   named warning and the transport still resolves to `noTransport` — the
   opt-in is preserved, not defaulted; `--wake` against a `canWake: false`
   transport reports that plainly rather than implying a session was woken.
7. the warning reaches the operator from the **foreground** launch command
   exactly once, and the detached controller prints nothing — asserted
   through the real detached path, not captured function output.
8. `SKILL.md` documents the arming command and the launchd line;
   `operations.md:129-131` matches `notify/index.mjs`, asserted by the docs
   test.

## Phase 5a — a loop that cannot freeze

**Problem, cited, with the citations corrected twice over.**
`run-command.mjs` settles on `close`, on `error` (`:213`) and on spawn failure
(`:218-225`) — the defect is narrower and worse than "settles only on
`close`": **the timeout path never settles at all.** Its timer kills the group
(`:149-153`) and settlement still waits for `close`, which a grandchild
holding the pipe never delivers, and that `await` is on the loop's critical
path (`lifecycle.mjs:442`). It already spawns `detached` (`:194`) and its timer
already terminates the group — the defect is the settle, not the spawn.
`judge-gate.mjs:124-131` spawns with `shell: true` and no `detached`, so its
timeout kills the shell only. Synchronous git is unbounded, and the inventory is wider than an earlier draft
said: `repo/worktree.mjs` funnels **one** `execFileSync` call site (line 53,
inside `runGit`), and unbounded synchronous git also runs at
`host/preflight.mjs:59`, `:109`, `:455`, `:468`, `engine/live-preflight.mjs:95`
and `engine/run-identity.mjs:152` — the last on the resume identity path. A
static test scoped to `repo/` would pass while every one of those survives. A node can be `running` with no
job (`settle.mjs:119` → `integrate.mjs:99-110`, which can return `null`; the
job was already deleted at `lifecycle.mjs:180`) and the loop spins at 1 Hz.

**Change.** `run-command.mjs` and `judge-gate.mjs` settle **from the timer**
with `timedOut: true` and destroy the streams, rather than waiting for
`close`; `judge-gate.mjs` also spawns `detached` and kills the group.
**Cancellation settles immediately too** — a timeout-only fix leaves an abort
able to hang forever. Every synchronous git subprocess is bounded through **one wrapper** covering
`execFileSync` and `spawnSync` alike, with a static test scoped to **all of
`src/`** — not `repo/` — or, where a call is exempt because it is a read-only
probe that cannot take `index.lock`, that exemption declared by name in the
test rather than left as an uncovered gap.

**The pre-termination hook, and where it lives.** Phase 5b interposes
quiesce → seal → terminate, and that can only happen at the site that kills:
`terminateProcess` and `detectStalls` in `process.mjs:310-337`, which today
`await terminateProcess(job)` and only then `await onTimeout(...)`. None of
5a's other changes touch that site, so 5a introduces the hook there — with its
own done-when — and 5b fills it.

The loop invariant is **narrow**: a node whose `status === "running"` but
which is absent from the controller's `running` map transitions to `blocked`
with `integration_unresolved`. An earlier draft said "non-terminal, not
pending, absent from running", which would have swept up phase 2's parked
`blocked`/`failed`/`exhausted`/`stalled` states and overwritten them every
tick — and destroyed the `runtime_tier_exhausted` waiting shape with them.

**Done when (5a):**
1. a child that escapes the group and holds the pipe open settles from the
   timer with `timedOut: true` and the loop continues — today it never
   settles.
2. an aborted command settles immediately as well, not only a timed-out one.
3. the killed process group leaves no surviving grandchild, asserted on the
   group.
4. a bounded synchronous git call blocked on `index.lock` returns by its
   timeout with a named error, for both `execFileSync` and `spawnSync` paths.
5. a static test fails on any unbounded synchronous git call added anywhere
   under `src/`, and every exemption it allows is named in the test.
5b. the pre-termination hook exists at `process.mjs`'s kill path and is
   invoked before `terminateProcess`, asserted with a no-op filler so 5a
   stands on its own without 5b.
6. a node `running` but absent from the `running` map becomes `blocked` with
   `integration_unresolved` within one tick.
7. **negative cases:** a parked node and a `runtime_tier_exhausted` waiting
   node are left untouched by that invariant, tick after tick.

## Phase 5b — seal before kill, and a stall threshold that fits the runtime

**Problem, cited.** Stall detection is stdout/stderr **mtime**
(`process.mjs:305`) and is skipped outright for non-streaming harnesses.
`wall_clock_timeout` is in `NON_FAILOVER_CODES`; `stall_timeout` is **not** —
`progress_stalled`, emitted by `resume.mjs:264` during recovery, is. Both
timeout codes are in `NODE_DEADLINE_CODES` (`backoff.mjs:55`). The attempt
worktree is not sealed before the kill; one recorded take lost 58 minutes of
work mid-file that way.

**Change.** On `wall_clock_timeout` and `stall_timeout`, seal the attempt
worktree **first**, then kill, so the next attempt is cut from the seal — the
rule every other retry already follows — and phase 2's single `auto_retry`
becomes possible for both. Sealing needs a coherent procedure, not an
ordering wish: **quiesce, seal, then terminate**, with declared bounded
behaviour when the provider is still writing or holds `index.lock`. Today's
monitor kills before calling the timeout callback — `process.mjs:310-312` and
`:335-337` both `await terminateProcess(job)` and only then
`await onTimeout(...)` — so 5a introduces the pre-termination hook at exactly
that site and 5b fills it. The site is named in both phases so they cannot
silently disagree about where the seal interposes.

`stall_timeout` and `progress_stalled` are two codes for one condition,
emitted from different places, with only the latter in `NON_FAILOVER_CODES`.
This phase unifies them or documents the distinction; it is not a blocker for
the rest.

Stall becomes tool-event based for harnesses that stream, with a **per-runtime
threshold** `runtimes[id].stallTimeoutSec` — the contract-level default is a
single 300 s (`contract/index.mjs:333`) with no per-runtime override, which is
aggressive for a model reasoning at `xhigh`. Its validation, its fallback to
the contract value, and the concrete value chosen for `zcode` are part of this
phase. The tier-exhaustion hold gains a numeric cap and raises `attention`
when exceeded, with the post-cap transition named explicitly.

**Why stall stays a duration policy.** The review recorded a 971 s silent gap
*inside a successful attempt*: no local CPU, no tool event, no output — from
outside, identical to a dead provider. No available signal separates the two,
so this phase does not pretend one does. What makes the false positive cheap
is the rest of this phase: the seal survives the kill, and phase 2's
`auto_retry` picks it up.

**Done when (5b):**
1. `wall_clock_timeout` and `stall_timeout` each seal the attempt worktree
   before the kill, and the next attempt is cut from that seal with the work
   intact — asserted on seal contents.
2. sealing follows quiesce → seal → terminate, and a provider still writing,
   or holding `index.lock`, produces the declared bounded outcome rather than
   a hang.
3. 5a's pre-termination hook is what 5b fills — asserted by a test that fails
   if the kill precedes the seal.
4. both timeout codes reach phase 2's single `auto_retry` with a non-empty
   seal, and park with an empty one — this is where their positive cases
   live, because only here does a production seal exist to test against.
5. a streaming harness that emits a tool event but writes no file for longer
   than the mtime threshold is **not** stalled.
6. **and** after a tool event, silence longer than the runtime threshold does
   eventually stall — an implementation that disables stall forever after the
   first tool event must fail this.
7. a runtime with its own `stallTimeoutSec` is judged by that value; an
   invalid one is rejected at validation; an absent one falls back to the
   contract value; `zcode` has its declared value and is stalled by it.
8. the tier-exhaustion hold is capped at its declared numeric value, raises
   `attention`, and takes the named post-cap transition.
9. `stall_timeout` and `progress_stalled` are unified; if they are not, the
   assertion pins the failover-membership semantics as intended —
   `stall_timeout` absent from `NON_FAILOVER_CODES` while `progress_stalled`
   is present (`backoff.mjs:31-37`) — rather than a prose paragraph restating
   the status quo, which any implementation could satisfy by writing it down.

## Phase 6 — spend less per node

**Problem, cited and measured.** Gate retries reuse a continuation
(`dispatch.mjs:78`), so the provider re-reads the whole failed transcript and
then gets the packet again, while the bounded `## Previous attempt` section
(`retry.mjs:23`, 8 KiB) already carries the evidence. `prompts.mjs:144`
serializes `state.verification` whole — 2 KiB stdout plus 2 KiB stderr per
command per attempt, green or red — worst case failing the node
`judge_prompt_too_large`. `judge-gate.mjs:63-66` skips the judge only when no
item is `judgment: true` — and `judgeRequired` also requires
`reviewMode(gate) !== "none"`, so `skipWhen` composes with a gate that already
exists rather than replacing it. Cost appears once, on `run.terminal`: the two most
expensive nodes in the history spent $62.90 between them and both ended
blocked and failed respectively — the operator canceled the *runs* minutes
later, recorded in their `cancel.request.json` — with no line anywhere saying
so while the spend happened. Worker calls
average 9,253,515 prompt tokens, 98.9% cache read, and cache read is billed.

**Change.** Carry an explicit **session policy** (`forceFresh`) through
`applyRejection` into dispatch: merely nulling a local `continuationId` will
not stop dispatch from rediscovering the prior compatible continuation. Send
the judge `{argv, passed}` for green commands and output tails only for red
ones. Add `gate.skipWhen: {verificationGreen: true, maxChangedPaths: N}`,
checked in `startJudge`, with its rule stated unambiguously: **when both
conditions hold the judge is skipped even though items would normally require
judgment; when either fails, ordinary `judgment: true` logic applies**. As a
rule that could never override `judgment: true` it would add nothing, since
the existing code already skips when no item needs judgment.

Emit an **advisory** per-node line when a node crosses a configured cost or
duration — never a kill; the no-ceiling decision is deliberate and measured.
Its configuration schema, units, defaults, one-shot behaviour and persistence
across restart are declared. It is routed through phase 4's inbox rather than
a detached controller's stdout, which is discarded. Cost timing is stated
honestly: duration is observable live, but cost is recorded when an
invocation closes, so cost advisories fire when new usage records arrive.
Totals gain `worker $X · judge $Y`.

**The fresh-session change is a measured hypothesis.** `cacheReadPerRevision`
is defined as cache-read tokens attributable to gate revisions divided by the
number of gate revisions, computed over this campaign's own runs, with the
before cohort the runs preceding the change commit and the after cohort those
following it, written to a named artifact path. If the campaign produces no
post-change gate revision, the artifact records that absence explicitly rather
than an empty comparison.

**Done when:**
1. a gate retry dispatches with no continuation — asserted through the real
   dispatch path, proving `forceFresh` survives into dispatch and the prior
   continuation is not rediscovered — while the retry prompt still carries the
   bounded `## Previous attempt` evidence.
2. **measured:** `cacheReadPerRevision` is computed by the declared formula
   over the declared cohorts and written to the named artifact; if no
   post-change revision exists, the artifact says so. The case is the
   measurement being recorded, not a threshold met.
3. the judge prompt for an all-green set carries `{argv, passed}` and no
   output bodies; one red command carries its tail.
4. a verification set that exceeds the 64 KiB guard today fits after the
   change.
5. `skipWhen` with both conditions true skips the judge **even when an item is
   `judgment: true`**; with either false, ordinary judgment logic applies. One
   test per half, plus one proving it composes with `reviewMode(gate)` rather
   than overriding a gate whose review mode is already `none`.
6. a node crossing its configured cost or duration emits the advisory and **is
   not killed** — asserted explicitly, the node runs to completion — with the
   line delivered through the inbox, not detached stdout.
7. the advisory is one-shot per node per threshold and survives a controller
   restart without re-firing.
8. totals carry `worker $X · judge $Y`, and a run with unavailable or partial
   cost for either role neither fabricates `$0` nor double-counts.

## Deliberately not changed

From the review's own boundary section, re-examined and not reopened: **no
hard spend ceiling** (phase 6 emits a line, never a stop); **no rewrite** — with the
honest qualification that three records here are genuinely new
(`heartbeat.json`, `contractDigest`, the inbox); what the boundary means is
that the *diagnostic* signals these phases consume — node `updatedAt`,
`livenessState()`, per-role `usage.jsonl`, `status.json` checkpoints — are
already written and merely unread, so no existing subsystem is replaced; **log and worktree gc** (161 MB and 208 MB) is left to
its own proposal, costing disk rather than hours; **provider preambles** are
the provider's to trim.

## Campaign 2, named so this one can be finished

`status` with a progress line and ETA, `--brief`, `compactCost` decimals, the
`dashboard` verb and `next` in `SKILL.md`; the composed-pool-shrink warning —
whose eligibility must use the composer's **effective** availability, tier
equivalence and the cross-vendor rule (`runtime-discovery.mjs:96`, `:170`),
not "same tier and unavailable", and which must survive a resume; the
documentation diet; protecting the run from its operator; and the frozen
`stable` build with the live eval class gating promotion.

Two things are recorded now so campaign 2 does not rediscover them. First, the
creation-side half of a finding this campaign only half-dissolves:
`runContract()` validates against the live, possibly dirty worktree
(`scheduler.mjs:80`) and then cuts attempt worktrees from the committed
`gitHead`, so the validator can see files the worker will not have — its
regression is named in advance, a dirty edit hiding a cross-node conflict
present in `HEAD`. Second, the dirty-tree refusal must exclude the paths the
factory itself dirties: the AGENTS.md managed block leaves `M AGENTS.md` in
`git status` right now, written by `campaign init` in this very session.
Either the refusal ignores factory-managed paths or the factory commits its
own block.

## Delivery

Every phase boundary runs its named deterministic tests, the whole suite,
`npm run typecheck`, and the evals as **two separate commands** —
`evals/run.mjs --class deterministic --assert-no-model` and
`evals/run.mjs --verify-discriminating` — because `--verify-discriminating`
returns before executing the deterministic cases and cannot stand in for the
run.

The phases are sequential closed packets in the order given, and they are not
independent: 2.1 precedes 2.2 because the outcome reduction performs a
persisted contract load; phase 3 consumes phase 2's `runOutcome` and
`contractDigest` and phase 1's heartbeat; phase 4 renders phase 2's outcome;
phase 5b fills a hook phase 5a introduces and supplies the seal phase 2's
`auto_retry` depends on; phase 6's advisory is delivered through phase 4.
