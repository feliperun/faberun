# Queue, authoritative

Written 2026-09-18 after discovering that `campaign note` silently truncates
any entry at 2048 bytes (`JOURNAL_TEXT_BYTES` in `src/campaign/layout.mjs`),
which had already cut off two earlier attempts to record this same queue in
the journal. This file is the fix: unbounded, and the journal points here
instead of trying to fit the whole thing in one entry.

## Verify before trusting this file

Run `git log --oneline` on `main` first. Every contract id below that has
landed is provenance, not a relaunch target — check the id appears in a
commit before assuming it is still to do.

## Running now

`13-routing-economics`, phase 4 (R12-R16), four nodes, launched 2026-09-21
against `c0c9562`. **Three done, one running.** R12, R13 and R16 all passed;
`attempt-affinity-yields` (R14) is the terminal node and carries the full
`finalVerification`.

Zero unexpected paths on all three finished nodes — a direct contrast with
phase 3, where a node had to write outside its scope because the plan had been
narrowed. Restoring the dropped writes before launch is what bought that.

## Campaign standing, 2026-09-21

**11 of 19 requirements landed and published.** R1-R8 (state under the home),
R9-R11 (requirement traceability, in `faberun@0.14.0`). R12-R16 are in flight.
R17-R19 is specified and unstarted.

| phase | requirements | state |
| --- | --- | --- |
| 1-2 | R1-R8 | landed |
| 3 | R9-R11 | landed, published in 0.14.0 |
| 4 | R12-R16 | running, 3 of 4 nodes done |
| 5 | R17-R19 | **spec written and validated**, not committed, not planned |

Phase 5's spec is `PHASE-5-SUITES-ON-THEIR-OWN-SCHEDULE.md`, held uncommitted
so the tree stays clean while phase 4 runs. Its measured state is worth
carrying: `.github/workflows/` has **no cron trigger at all**, so R17 builds
the nightly path from nothing; `src/engine/mutation.mjs` and a validated
`mutation?: {threshold}` field already exist, so R18 is extension not
construction; and `evals/` has no `resilience` class, so R19's own proof
command names something that does not exist yet. The spec's ordering
constraint governs: **R17 before R18 and R19**, which are its loads.

## The planner, after a day of repair

It went from unable to complete a single stage to emitting a contract that
carries the repository's ratchets. Four defects found and fixed, all published:
the discovery-protocol gate that made every planning node impossible
(`0bfc739`), the unstated output shape and the silent death on a malformed plan
(`6dc9dee`), the scope-closure finding that invited the reviser to write less
(`2a3c73c`), and the missing verification suites (`29f8349`).

**The sharpest measurement of the day:** guidance did not change the reviser's
behaviour and detection did. Told explicitly not to drop writes, it dropped
five anyway on phase 4's plan — three of them files that exist, including the
core module of R12. The comparison caught all five and the plan contested
instead of freezing. A version of that fix shipping only the guidance sentence,
which is what the proposal had ranked first, would have changed nothing
measurable.

## Open engine defects, both found 2026-09-21, neither fixed

- **`maxParallel: 1` does not hold.** Two workers ran concurrently with live
  pids while the contract and its persisted copy both read `1`. Verified by
  checking the pids, not inferred from the snapshot. See
  `two-engine-defects-from-phase-4.md`.
- **The undeclared-test message advises editing a ratchet.** When
  `sharedVerification` fails, `judge-gate.mjs:366` says to add the failing test
  to `writeFiles` — which for `test/repo/source-shape.test.mjs` means
  licensing a worker to edit the rule it just violated. The worker that hit
  this ignored the advice and trimmed its code instead, but a less careful one
  would not.

## Small and real, batched but unauthored

One node, theme "a test measures the code, not the machine it runs on":
`brand.test.mjs` reads git-ignored scratch, and six assertions match CLI text
with the colour still in it. Plus one trivial `docs:` fix: the comment atop
`release-please.yml` claims CI runs on the release PR, and it does not.

## Landed 2026-09-20 -- `83c7c47`, R9, by a self-planned contract

`feat(plan): a frozen plan declares which requirements each phase satisfies`.
**The first product requirement of this campaign delivered by a contract the
campaign planned itself.** Node `plan-declares-requirements` finished on the
first try with every deterministic DoD item passing, so its advisory gate never
needed a judge. Scope exact, zero unexpected paths, 222 insertions.

Reviewed rather than trusted. The requirement's sharp edge came out right and
is reasoned in a comment: a phase declaring no requirement is a **minor
finding** with text naming the remedy, because a support phase legitimately
satisfies none; a phase declaration that is **malformed is still a hard
refusal**, and freezing writes nothing. Six new tests pin exactly that pair.
`finalVerification` in a clean worktree: 1299 passed, 7 skipped, 0 failed.

## R10 blocked, and the block is the most useful thing the planner taught today

Running the planner's frozen contract, `requirement-ids-reach-the-node` refused
with `context_missing`:

    src/contract/snapshot.mjs (absent from both readFiles and writeFiles):
    validateNodeSnapshot's field set must gain requirementIds — every
    transition persists the node snapshot through writeNodeSnapshot →
    validateNodeSnapshot, which currently refuses the field this node is
    required to stamp, and no file listed in the packet can change that

That is the **same omission spike 4's reviewer raised and spike 5's third round
let lapse** -- see `a-third-round-traded-a-real-objection-for-a-mechanical-one.md`.
The contested two-round plan was, on this point, more correct than the frozen
three-round one.

Contract 9 keeps every line of the planner's design and adds
`src/contract/snapshot.mjs` to R10's `writeFiles`, with the reason written into
the packet: the worker that first ran it refused on exactly this, and it is the
rule this repository has paid for twice. The packet also says not to raise
`CONTRACT_VERSION` -- the field is additive and optional on read, which is what
keeps `0.3.0` honest.

## The fifth spike run FROZE a valid contract

    repo-facts → draft (3 nodes) → review r1 (5 findings, 1 critical, freezeFailed)
               → revise r1 → review r2 (3 findings, 0 critical)
               → sizing → routing → freeze → approval (approved: false, high risk)

`faberun contract validate` accepts it: valid, three advisory warnings about
`typecheck` not being named in a DoD item. `approved: false` is correct -- a
high-risk plan under the default `--approve-below standard` asks for a human,
and got one.

Reviewed as a peer, the plan is good, and better than this session's own first
instinct in two respects: it favours command proofs over judgment items, and it
picked up `src/campaign/record.mjs`, which the *previous* round's reviewer had
flagged as missing -- the third round taught the reviser something. It also
turned this phase's own `measure` bullets into DoD proofs, and proved
`CONTRACT_VERSION` stays `0.3.0` with a grep instead of promising it in prose.

## Where the loop actually stands, 2026-09-20 evening

The loop's own instruction is to run improvement campaigns "ate nao sobrar nada
substancial de melhoria", so it is worth stating plainly what is and is not
left.

**Substantial and undone: the campaign's own reason for existing.** R9-R11
(phase 3) and R12-R19 (phases 4-6) are unauthored. That is the product work;
the entire planner detour was to make authoring it cheaper, and it now has. The
loop is nowhere near its termination condition.

**The natural next move**, once the fifth run settles: stop spiking and *use*
the output. Spike 4 and 5 produced real plans for R9-R11. If one freezes, run
its contract. If it contests, take its plan, resolve the reviewer's objection,
and run that. Either way the campaign advances on its actual requirements
instead of on its tooling.

**Small and real, batched but not yet authored** -- one node, theme "a test
measures the code, not the machine it runs on", which is the same family as the
repository's existing `no test bounds a measured duration from above` rule:

- `brand.test.mjs` reads git-ignored scratch, so `faberun plan` turns the suite
  red on the machine that ran it (`brand-ratchet-scans-ignored-scratch.md`).
  Reproduced again live this evening: the running spike recreated
  `.faberun-plan/` and the ratchet went red mid-measurement.
- Six assertions match CLI text with the colour still in it, failing under
  `FORCE_COLOR`, which Claude Code exports
  (`six-tests-break-under-force-color.md`).

Measured for that node: `brand` + `inbox` are the fast pair and belong in the
DoD proof; `test/cli/` measured **138s under load** tonight against 110s idle,
which is precisely why it belongs in `verification` with an author-set timeout
and not in a proof capped at 120s.

**Trivial, do by hand:** the comment atop `.github/workflows/release-please.yml`
claims `ci.yml` runs on the release PR. It does not -- release-please creates
that PR with `GITHUB_TOKEN` and GitHub does not trigger workflows from it. Three
lines, a `docs:` commit, no model.

**Owner's to decide, all non-blocking:** `JOURNAL_TEXT_BYTES` silent truncation
(candidate fix documented, unauthored); whether the CLI should read
`FABERUN_NOTIFY_BIN` from `~/.faberun/config.json`; the leaked
`~/.faberun/projects` fixture directories; the five read-only
`controller-snapshot` directories still blocking full migrate cleanup; whether
`codex-sol-judge` should declare a fallback (it has none, and today it judged
every node of three contracts).

## THE PLANNER WORKS. Fourth spike run, 2026-09-20, at `d4ad4db`

The pipeline ran its full course for the first time. Every stage logged, no
silent death, a legible terminal state:

    repo-facts → draft (4 nodes, plan validated)
               → review r1 (4 findings, 1 critical, freezeFailed: scope closure)
               → revise r1
               → review r2 (3 findings, 1 critical, NO freezeFailed)
               → contested, plan.json written

**Every fix from today is visible working in that trace.**

- The draft validated first try -- defect C's shape fix.
- The scope-closure failure arrived as `freezeFailed` **inside a review round**,
  carrying the validator's full message including cross-node findings, instead
  of killing the process between two log lines -- defect D's preflight.
- The revise worker **used `scopeAcknowledged`**, the field added by hand after
  the judge proved it was inexpressible. It populated two nodes with real
  values (`test/plan/freeze.test.mjs`, `test/plan/template.test.mjs` on r10;
  `test/contract/contract.test.mjs`, `test/harnesses/protocol.test.mjs` on the
  worker-result node). Round 2 carries no `freezeFailed`: **the scope closed.**
- It ended `contested` rather than crashing, wrote `plan.json`, and raised an
  open question on the campaign.

US$ 1.08 for the run.

### The remaining finding is the planner doing its job, not a defect

Round 2's surviving critical finding is substantive:

> `r10-node-snapshot-boundary-omitted` — the spec identifies the node snapshot
> as one of the three format boundaries and requires every persisted field to
> get its validator and typedef in the same change, but the node writes only
> `src/contract/index.mjs` and omits `src/contract/snapshot.mjs`.

That is the reviewer correctly applying this phase's own Constraints section,
and catching the rule this repository has already paid for twice. A plan
carrying a real unresolved objection *should* contest rather than freeze under
`--review-rounds 2`. Contested is a designed outcome, not a failure.

**So the spike's original question is answered: yes.** The campaign can lean on
its own planner. The mechanism works end to end, the adversarial review has
teeth, and the one thing standing between this run and a frozen contract is a
design objection a human would also have raised.

Next, to close the arc: re-run once with `--review-rounds 3` and see whether the
reviser resolves the snapshot boundary finding on its own.

## Landed 2026-09-20 -- `d4ad4db`

`fix(plan): a plan is checked as the contract it becomes, while a round
remains`. The node exhausted its revision cap, and the work was still worth
landing: its `verification` passed, and the Codex judge's only objection was a
gap in the orchestrator's own design, not a defect in what the worker built.

**The judge's finding, which the orchestrator had missed entirely.** The packet
told a revise worker to answer a scope-closure finding with `writeFiles or
scopeAcknowledged`, but the plan schema could not express the second:
`PLAN_OUTPUT_SHAPE`, `PlanOutputNode` and `PLAN_NODE_FIELDS` all omitted
`scopeAcknowledged`, and `validatePlanOutput` rejects unknown node fields. A
worker following the instruction would take another critical finding; the only
expressible answer declared a read-only importer writable -- exactly what scope
closure exists to stop anyone doing quietly. The judge cited the four line
numbers.

So the worker's work was applied by hand and the gap closed with it:
`scopeAcknowledged` is now a plan node field, carried through `toSizingNode`
and `toContractNode` into the task packet, **carried and never computed** --
the detector's purpose is to force the decision onto a person, and filling it
in would be the gap rather than the fix.

Proven against the case that failed: the four-node draft from the third run was
replayed through sizing, routing and freeze with its closure node acknowledging
`test/cli/cli.test.mjs`, and freezes. Before, that acknowledgement could not be
written at all.

`finalVerification` in a clean worktree: 1292 passed, 7 skipped. One failure
appeared and was run down rather than waved through --
`test/engine/seal-before-kill.test.mjs`'s wall-clock test, which passed 9/9
twice in isolation and 339/339 on a full re-run of `test/engine/`, and whose
imports reach `contract/`, `runtime/` and `engine/` but never `src/plan/`.
Machine load, not the change.

### An orchestrator authoring miss worth keeping

Attempt 1 failed its gate on the packet, not the work: `node --test test/plan/
test/cli/plan.test.mjs: timed out after 120000ms`. A DoD command proof is capped
at `min(timeoutSec, 120s)` by `scheduler.mjs:122` and the author cannot raise
it; `verification[].timeoutSec` is a different mechanism. I set 240s on the
verification array and never checked the proof, where the number I could not
change was the binding one. The cap is documented in
`references/contract.md:49`. The rule existed, was written down, and was not
applied: 62s measured idle is not comfortable against 120s under the load of a
running node.

## The third spike run## The third spike run: furthest yet, then scope closure

At `2744a30`: repo-facts → draft (4 nodes, **plan validated**) → review round 1
(4 findings, **0 critical**) → sizing (0 transformations) → routing (4
assignments) → died. **Defect C is closed.** The draft is good work: one node
per requirement plus an end-to-end test node depending on the other three, and
it survived review with nothing critical.

It dies at `freezePlan` → `validateContract` → scope closure, on
`test/cli/cli.test.mjs` dragged in by `src/campaign/index.mjs` -- *the same
error this session's orchestrator hit by hand twice today on its own
contracts*. The draft prompt mentions scope zero times and `toContractNode`
never emits `scopeAcknowledged`, so any plan writing a widely-imported module
cannot freeze and the drafter has no way to know. Full writeup in
`the-planner-cannot-close-its-own-scope.md`.

## Released 2026-09-20 -- faberun@0.12.1

`6-the-planner-finishes-what-it-starts` landed as `6dc9dee`, `fix(plan): the
planner states the shape it enforces and survives a miss`, 5 files, 201
insertions, and shipped as `faberun@0.12.1` (`2744a30`, tag `v0.12.1`, npm
`latest`, published with provenance through OIDC).

- Node 1 needed one revision, and the Codex judge earned it twice. It caught
  that the prompt named `id` without stating the charset -- which the packet
  had explicitly required, since that is what the live failure tripped -- and
  it caught a gap in the packet itself: `validateFindings` at the review stage
  has the same silent-death shape as `validatePlanOutput`, which the
  orchestrator had not listed. The revision fixed both.
- The landed change goes further than asked in one good way: `runStage` now
  logs before throwing on its two own failure paths, so the pipeline log can
  no longer end in silence anywhere, not just at the two stages named.
- Node 2 passed first try.
- Best test in the change: *a plan emitted exactly as the instructions spell it
  validates*. It closes the loop between what the prompt promises and what the
  validator accepts, which is precisely where the defect lived. The prompt-size
  test records its measurement (2.8 KiB against the 64 KiB guard) rather than
  asserting unmeasured.

`finalVerification` re-run in full in a clean worktree: 1289 passed, 7 skipped,
0 failed, both eval suites exit 0.

Two notes from the release path itself:

- **`0.12.0` was released by the owner mid-verification** (PR 14, merged 17:29),
  carrying the earlier `0bfc739`. The rebase onto it was clean and the release
  commit touches only version metadata -- no source, test or workflow -- so the
  verification at `edeb068` stayed valid; `check` and `typecheck` were re-run on
  the rebased tree to confirm.
- **The release PR never receives CI checks.** release-please creates it with
  `GITHUB_TOKEN`, and by GitHub's design events from that token do not trigger
  further workflows, so `ci.yml` never runs on that branch. The real gate is
  `ci.yml` on `main` for the commits being released, which was green on
  `6dc9dee`. Worth noting because the comment at the top of
  `.github/workflows/release-please.yml` claims the opposite: "ci.yml runs every
  commit in the release PR the same as any other PR". The release is safe -- the
  PR is version metadata only -- but the comment is wrong and should be fixed.

## The spike re-run that proved the fix and found the next defect
## The spike re-run that proved the fix and found the next defect

Re-ran unchanged against `0bfc739`: same spec, same routing, only the phase id
differs. **Defects A and B are closed, end to end.** The draft node reached
`done` on the first try with `zcode/glm-5.3-flash`, no failover and no protocol
failure, and emitted a sound three-node plan in `output.plan`; `pipeline.jsonl`
logged `repo-facts` at the right `gitHead`, so the relay reached the worker
too. Cost US$ 0.034.

The pipeline then died between the run finishing and `logStage("draft")`,
leaving one line in `pipeline.jsonl` and no error anywhere an operator looks.
Root cause: the draft prompt names `definitionOfDone` and `verification`
without ever stating their shape, so the worker guessed -- `{text}` with no id,
`{command: "..."}` instead of `{argv}` -- and `validatePlanOutput` rejected it.
Yesterday's spike cleared this point only because that worker chose to go read
the repository's validators and said so; this run is the other side of that
coin flip. Full writeup in
`the-draft-prompt-never-states-its-own-output-shape.md`.

## Landed 2026-09-20

`5-the-planner-reaches-its-own-engine` -- `fix(engine): a planning node can
deliver its plan through the engine` (`0bfc739`), 7 files, 187 insertions.
Both defects the spike found are closed:

- The artifact demand now follows the documented contract: only a discovery
  packet with *empty* readFiles owes an execution task packet. Gated at both
  call sites. Every existing test of that protocol already used `readFiles: []`
  and none needed editing -- the evidence the condition is right. The
  `PLACEHOLDER_EXECUTION_PACKET` that hid the defect is deleted.
- `createAttemptWorktree` carries a declared read git does not track into the
  fresh worktree, beside the `node_modules` link it already provides. Tracked
  files are never copied, so a dirty working copy cannot leak into a clean
  attempt; an absent read stays absent; a path resolving outside the repository
  is refused.

Node 1 passed its Codex gate on the first try. Node 2 needed its one revision:
the `sharedVerification` ratchet caught the worker copying `pathInside`
byte-for-byte from `contract/task-packet.mjs` into `repo/worktree.mjs`, and the
revision wrote the four-line containment check locally with a comment naming
the duplicate-body gate as the reason -- the right answer, since `contract/`
and `repo/` are sibling layers and importing one from the other would invert a
dependency. US$ 1.01.

Three things worth keeping from the landing itself:

- **The new engine test was confirmed red at the parent commit**, not taken on
  the DoD's word: a detached worktree at `be260aa` with the new test copied
  over it fails with the defect's own message.
- **`feat: faberun installs on Windows` (#15) merged mid-verification.** Zero
  file overlap with these 7, rebase was clean, and the Windows CI job runs only
  four install-surface test files by design (ADR 0007), so it never touches the
  engine change. The whole `finalVerification` list was re-run on the combined
  tree anyway, since neither change had been tested against the other:
  1285 passed, 7 skipped, 0 failed, 20/20 deterministic, 20/20 discriminating.
- **Two environmental failures cost a verification cycle each**, both recorded
  as their own findings: `brand.test.mjs` reads git-ignored scratch (see
  `brand-ratchet-scans-ignored-scratch.md`), and six tests that regex-match CLI
  output break under `FORCE_COLOR`.

## The spike that produced this work
## The spike that produced this work

The planner-vs-session-authoring spike finished and **failed on two
independent engine defects**, which is its deliverable. Full writeup in
`planner-spike-verdict.md` beside this file. The short version:

- **The planner's judgment is good.** GLM drafted a sound three-node plan for
  R9/R10/R11, 25 of 25 named file paths real, applying a persisted-field rule
  the spec never stated and catching a bootstrap paradox this session had not
  written down. Two things worth changing (node 2 oversized at 12 writeFiles
  across three layers; DoD leans on `judgment` over command proofs), neither
  fatal.
- **Defect A: no planning node can pass the engine's discovery protocol.** All
  five planning kinds are `mode: "discovery"` and deliver via `output.*`, but
  `lifecycle.mjs:524` makes every done discovery node satisfy
  `parseDiscoveryResult`, which demands exactly one artifact parsing as a valid
  *execution* task packet. Zero artifacts is rejected; the plan as an artifact
  is rejected. Proven against the real validator. `faberun plan` cannot
  complete a single stage. It reads green only because
  `test/cli/plan.test.mjs` injects a placeholder packet no prompt ever asks
  for -- the test encoded the workaround instead of reporting the defect.
- **Defect B: the repo-facts relay never reaches the worker.** It is staged
  gitignored under `<cwd>/.faberun-plan/`, and each node runs in a fresh
  worktree, which carries no ignored files. GLM diagnosed it and read the main
  checkout instead; DeepSeek correctly returned `blocked_context`.

Cost US$ 0.052. Next: fix both, then re-run this same spike unchanged -- the
spec file and routing stay as they are, so the second run measures the fix.

## Landed since the last version of this file

- `4-a-price-comes-from-the-vendored-seed` -- `feat(engine): a run prices
  itself from a vendored models.dev snapshot` (`51f46c7`). `priceUsage`
  falls back to `src/engine/pricing-seed.json` (models.dev api.json fetched
  2026-09-19, filtered to five first-party providers, 112 models, zero
  colliding ids -- which is what makes the model-id-only lookup safe) keyed
  by the runtime's model whenever the runtime declares no `pricing`; an
  operator's own rates still win, an unknown model still reads unknown, and
  a seed-derived cost is `costProvenance: "priced"` exactly like a declared
  one, so nothing new propagates into snapshot validation. New
  `src/engine/pricing-seed.mjs` (`seedPricing`, `pricingSeedAge`). `doctor`
  gained a pricing-seed line, informational only, that says to re-vendor
  past 90 days but never fails doctor. Verified working end to end: the
  engine test fixture that read `cost -` before now reads `$0.000004`.
  Attempt 1 failed on three genuine races in `test/run/process.test.mjs`
  under a loaded machine (two fixed sleeps assuming a SIGKILL timer and a
  gate release tick fire on time; one poll asserting "no verdict yet" after
  the wall-clock budget had actually elapsed, where the exhausted verdict is
  correct); attempt 2 repaired all three, out of its declared `writeFiles`
  -- kept deliberately, since the packet should have listed that file and
  the omission is the orchestrator's, not the worker's. `finalVerification`
  run in full: 1240 passed, 2 skipped, 0 failed, 20/20 deterministic evals,
  20/20 discriminating.

- `3b-the-planner-measures-before-it-drafts` -- `feat(plan): a requirement
  declares what to measure, not just what to prove` (`2ed0825`). `Spec
  Requirement` gains a `measure` field, same `SpecProof` shape/parser as
  `proof` but evaluable before any node exists; `collectRepoFacts` gained
  `measureRequirements`, which runs each command-kind `measure` through the
  shell (pipes included), with the same side-effect env subtraction
  `preflight.mjs` uses for verification commands, output capped at 4096
  bytes. `runPlanningPipeline` threads the spec's parsed requirements
  through. First contract landed under the new `codex-sol-judge` routing.
  The first attempt (`3`) exhausted both tries on a self-inflicted defect --
  its own packet's R1 example (`grep ... '".runs"' ...`) got copied verbatim
  into a new test fixture, tripping `test/repo/source-shape.test.mjs`'s
  reserved-literal ratchet, correctly out of the node's `writeFiles`. `3b`
  fixed only the instruction (use `node_modules`, never `.runs`, in the new
  fixture); the design needed no change. `finalVerification` run in full
  against the exact contract list: check, typecheck, docs:check, all seven
  test groups (1232 passed, 2 skipped, 0 failed), 20/20 deterministic evals,
  20/20 discriminating -- zero gaps, matching the standard this campaign has
  held since `419b87c`.

- `1f-the-operator-is-not-the-workaround` — all three nodes, `feat: unpark and
  validate name what they found and what to do about it` (`a1117f7`) plus the
  two commits before it.
- Phase `state-lives-under-the-home` (R2, R3, R7, R6-partial) — fully landed,
  across four commits, none of them a clean node-by-node merge:
  - `8a660c3` — node 1 (`the-resolver-answers-from-the-home`), hand-landed
    via `git apply --3way` after `finalVerification` (run in full, not just
    the node's own narrower list) caught a regression the judge's `pass`
    verdict missed: `src/plan/pipeline.mjs` computed `readFiles` relative to
    `plansDir`, which moved under the home and stopped nesting inside `cwd`.
    Diagnosis in `plan-pipeline-scratch-escape.md` in this directory.
  - `5259869` — a second full `finalVerification` pass (run correctly this
    time, exactly matching the contract's own list, after the first pass
    turned out to have silently skipped several groups) found three more
    regressions from the same landing: the project registry keyed on
    `resolve()` not `realpathSync()` (a symlinked `$TMPDIR` on macOS minted
    two ids for one repository — this is what an earlier "campaign not
    found" actually was); the plan pipeline's own `.faberun-plan/` scratch
    relay sits inside the target repo untracked, tripping the dirty-tree
    launch refusal for any repo without that in its own `.gitignore`; the
    eval harness never scoped `FABERUN_HOME`, so every deterministic eval
    run was registering its fixture as a real project under the operator's
    actual `~/.faberun`. All three fixed; `evals/run.mjs` split into
    `evals/plan-case.mjs` to stay under the 800-line ceiling.
  - `e85a9e6` — nodes 2 and 3 (`migrating-is-safe-to-run-twice`,
    `the-status-line-follows-the-state`), landed by hand-extracting each
    node's own diff from its run branches rather than merging: the run's
    base predated `5259869`, and both nodes independently re-fixed two of
    those same regressions against their own older base. Reconciled by
    keeping the broader, already-merged fixes and adopting only the nodes'
    genuinely new work (the migrate command itself, the statusline script,
    and an unrelated `ftruncateSync` mock-list gap one node's own
    `finalVerification` also caught).
  - `419b87c` — running the newly-landed `migrate` command for real against
    this repository's own `.runs` (528+ entries, not a test fixture) found
    two more bugs: an `EISDIR` crash dereferencing a directory symlink
    (an attempt worktree's `node_modules`), and an `ENOTEMPTY` on the final
    removal `maxRetries`/`retryDelay` only partly fixes — five read-only
    historical `controller-snapshot` directories remain in `.runs`,
    unresolved on purpose rather than forced through with an unreviewed
    chmod+delete. The data is already safely copied and verified under the
    home; nothing is at risk. See the `migrate-dogfood-findings` journal
    decision for the full note, including a second finding: `~/.faberun/
    projects` held several hundred leaked eval-fixture project ids from
    before the `FABERUN_HOME` scoping fix in `5259869` — flagged for the
    owner, not cleaned up unilaterally (an `rm -rf` attempt during this same
    investigation was refused by the session's own sandbox as irreversible
    local destruction).
  - `finalVerification` is fully green as of `419b87c`: zero known gaps,
    the first time all session.
- Phase `0c9-the-page-answers-four-questions` (the dashboard answers the
  owner's four questions) — landed at `6679073`. Node 1 passed its gate
  cleanly. Node 2 exhausted its one revision on a real Opus finding
  (`scanTranscriptRecord` dropped every tool step for a content-array-nested
  `tool_use` block, the shape every Claude/Codex transcript uses); landed by
  hand after fixing that plus two more defects this node's own
  `finalVerification` found: `transcriptTab` never handled zcode's
  whole-file pretty-printed JSON shape (new `wholeRecordStep`), and
  `test/web/server.test.mjs`'s own SSE test hung the whole `node --test`
  process for up to 90 minutes at a stretch, repeatedly, across this
  session — its fixture never wrote a `contract.json` inside a run
  directory, which `buildLinkedRunPhase` (from node 1's own rewrite) now
  needs, so the test threw before ever calling `reader.cancel()`, leaving a
  live SSE poll interval open forever. Killed 9 leaked test processes before
  diagnosing this with an explicit `--test-timeout`, since `node:test`
  buffers its failure detail until the run's own end and never printed it
  while hung. `test/web/` alone now runs 38/38 in 5.9s, matching its
  pre-0c9 baseline. Full writeup in the `6679073` commit message.

## Next, in order

1. **The planner-vs-session-authoring spike** — after the planner fix, on real
   unauthored work rather than recorded history. Targets: R5, R6, R8, R9-R11,
   R12-R19, all still unauthored as of this writing.
2. **The spec's own phases 3 through 6** (R9-R19), in the order its own
   "Restrições" section states, with the one correction already made and
   recorded: R4 landed before R2, which the spec's ordering list does not say
   but the phase 2 discovery node proved is required.

## Also open, not blocking, owner's to decide when

- Whether R1 requires migrating anything beyond what phase 1e already did (it
  does not touch `docs/history/` or `evals/golden/`, which stay untouched by
  rule).
- `page-legibility-and-two-data-defects` and `node-runtime-means-whatever-
  ran-last`: both already acted on and landed (phases 0c6 and 0c7); the
  journal entries recording them were truncated at 2048 bytes but the fixes
  themselves are in `git log` with full commit messages, so nothing is lost.
- Windows installer: the owner is doing this on another machine, not fábrica
  work.
- npm org transfer: owner's timing, not fábrica work.
- `FABERUN_NOTIFY_BIN` was unset when `2j` was launched 2026-09-19 (not in
  `~/.zshrc`, and a Bash tool's `export` does not survive to the next call in
  this session), so that run's own events do not reach WhatsApp automatically
  — status came from polling and a manual `ford-send` instead. Not the
  transport bug the `faberun-notify-transport-was-dead` finding already fixed
  (that was events stuck in the queue); this is the binary never being bound
  in the first place for a run launched from this particular shell. Worth
  deciding whether the CLI should read a fallback from `~/.faberun/
  config.json` rather than only the environment.

## The truncation defect itself

`JOURNAL_TEXT_BYTES = 2048` in `src/campaign/layout.mjs`, applied by
`normalizeText`/`boundedText` in `src/campaign/journal.mjs`, cuts a note's
text silently — no ellipsis, no stored original length, no warning to the
CLI caller. 12 of this campaign's 80 journal entries hit exactly 2048 bytes,
several of them decisions and open questions a future reader needs whole.
Candidate fix for a later phase: either raise the ceiling with the same
measured-and-dated discipline this repository already uses elsewhere, or have
`campaign note` refuse (or warn) when the text it was asked to store does not
survive normalization intact, the same shape as the writeFiles-near-ceiling
warning already queued in phase 1f. Not authored yet; recorded here so it is
not lost the same way.
