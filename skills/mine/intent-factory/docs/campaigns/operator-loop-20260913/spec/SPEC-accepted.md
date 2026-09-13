# Spec v5: operator loop

Target: /Users/frb/dev/frb/skills, the intent-factory skill at
skills/mine/intent-factory. Node 22, plain ESM `.mjs`, JSDoc-typed, no runtime
dependencies. Revised four times against an adversarial review. The fourth pass claimed a
single choke point, `normalizeProviderResult`, covered every cost-relevant
path; the reviewer traced the actual call graph and found that claim false in
two specific, verified ways — a live-usage backfill runs after normalization
and would price stale counters, and recovery threads cost through its own
`RecoveryOutcome` objects rather than through the normalizer's caller. This
pass names the real call sites, one at a time, each checked against the code
that exists today, and states plainly what stays out of scope: a delegation's
own crash safety, which this phase does not touch.

## Why

The 2026-09-13 deep review ran four live campaigns and found the mechanics well
proven and the operator's own loop unproven. This takes the four improvements
decidable from information the system already holds.

Review: skills/mine/intent-factory/docs/REVIEW-2026-09-13-deep-review.md

## Non-goals

- No live eval class, no evidence-driven routing, no golden-set execution, no
  sandbox work. Each needs its own campaign.
- No model prices in the tree. Prices are operator data or absent.
- **No file delivery into an attempt worktree.** An answered node receives text
  and nothing else. The review established why: an attempt is cut from the
  previous attempt's sealed sha or the run ref tip, not from the operator's
  checkout, so a file that appears in `contract.cwd` between attempts is not
  in the worktree the retry runs in. Making it so is a worktree-provenance
  change and belongs in its own campaign. Phase 2 says this out loud in
  `references/contract.md` so no operator expects otherwise.
- Phase 4 does not claim to remove comparison bias. A checkpoint with a priced
  judge and an unpriced worker still has partial cost evidence. The claim is
  narrower: a runtime the operator priced stops being invisible.

## Phase 1 — a dependency's output is legal to declare as a read

**Problem.** An execution packet's `readFiles` must exist at validation time, so
a node cannot declare the file a node it depends on will create. The workaround
is prose in `instructions`, which loses the closed-context listing.

**Change.** Contract loading, and only contract loading, may defer a
missing-read verdict to where the dependency graph is known. A missing
`readFiles` entry is accepted when a transitive dependency of that node declares
the same path in `writeFiles`, or under a `writeRoots` directory entry. Anything
else is rejected with today's message and today's label.

**Boundaries this must not cross.**
- `validateTaskPacket` stays strict for every other caller. `worker-result.mjs`
  validates a discovery node's produced packet with no graph in hand; that path
  must keep rejecting a missing read. The deferral is a parameter contract
  loading passes, never a default.
- Every other check in `validateRelativePath` still runs on a missing read:
  absolute paths, `..` escape, symlink containment, broken symlink. Only
  "does not exist" is deferred, and only for `readFiles`.
- A `writeRoots` entry that names a file authorizes that path only; a directory
  root authorizes what is beneath it. This mirrors the rule the scope
  comparison already applies.
- The returned packet object and therefore `packetHash` are untouched.

**Done when** — deterministic, named cases:
1. node B reads what node A writes, A is a direct dependency: valid.
2. node B reads what node A writes, A is a transitive dependency through C:
   valid.
3. the same, with B declared before A in the `nodes` array: valid.
4. node B reads what a non-dependency node writes: rejected, current message.
5. node B reads what B itself writes: rejected.
6. a path under a dependency's directory `writeRoots` entry: valid; the same
   path when that entry names a file: rejected.
7. a missing read that escapes cwd, or is an absolute path, or is a broken
   symlink: rejected with its own message, not the missing-file one.
8. a discovery worker result whose produced packet names a missing read is
   still rejected.
9. `packetHash` is unchanged for a packet whose read is deferred: build one
   contract with the read present and one identical contract with it absent but
   dependency-produced, and assert the two hashes are equal.

## Phase 2 — answer a blocked question and continue

**Problem.** `blocked_context` is the most common non-done terminal state and a
dead end. The worker states what it needs; the operator's only route forward is
a new run id and a re-authored contract.

**Change.** `resume --answer <node-id>=<path>`. The file holds the operator's
answer as text. The answered node, and only it plus its dependants, is
re-dispatched with that text carried into the next attempt's worker prompt and
into its judge prompt.

**Design, fixed by the review.**
- **Durability.** The answer is persisted as an execution override on the node
  snapshot, `kind: "operator-answer"`, with the required `at` and `reason` the
  validator already demands, plus the answer in a new `text` field.
  `executionOverrides` is *not* the loose record the previous draft assumed:
  `validateExecutionOverrides` rejects unknown fields against a fixed
  allowlist and requires `reason`, so this phase adds exactly one entry,
  `text`, to that allowlist and validates it as a bounded string. That is the
  only schema surface this campaign touches, it is additive, and no existing
  snapshot becomes invalid. The answer file is read once, at `resume` time;
  editing or deleting it afterwards changes nothing, and a crash after the
  record is written leaves the answer in place for the next resume.
- **Identity.** The authored packet is never modified, so `packetHash` and the
  resume identity check are untouched.
- **Delivery.** The answer is rendered into the node's `previousAttempt`
  section by `renderPreviousAttemptSection`. That section is appended to the
  worker prompt after `phaseInvocationPlan` resolves, so it survives a session
  rotation that replaces the prompt with a handoff, and `judgePrompt` already
  takes it as `context.previousAttempt`. One mechanism, both roles, retries
  included.
- **The stale result.** A blocked node has a valid canonical worker result on
  disk, and `resolveWorkerResult` prefers that file over the new provider
  response. An answered node must therefore clear its canonical result for the
  new attempt, the same way a failed gate already does. Historical evidence is
  untouched: the record lives in the node's invocations and logs.
- **Reach.** `--answer <node>` narrows the retry exactly as `--node <node>`
  does: that node and its dependants. Every other stopped node keeps its
  boundary, including a second node blocked for its own reason.
- **Repetition.** A second `--answer` for the same node appends a second
  record; the rendered section carries the most recent, bounded to the same
  ceiling as the rest of the section. Answers are never silently merged.
- **Bounds.** The file is read with a hard byte ceiling and rejected above it,
  with the ceiling named in the error. Untrusted operator text is bounded and
  delimited exactly like the judge and scope sections already are, and never
  changes `writeFiles`, `readFiles`, or any scope.
- **Plumbing.** `--answer` is forwarded through `resume --detach` the way
  `--node` and `--reconcile` are, and the flag is parsed with the same
  strictness. `<node-id>=<path>` with an unknown node id, an unreadable file,
  or a node that is not blocked on context is a refusal naming the reason.

**Node split.** Two nodes, because the review is right that this is too much for
one closed packet:
- **2a, the record.** Flag parsing, forwarding through detached resume, reading
  and bounding the file, the persisted override, and the retry-planner change
  that makes an answered node retryable and narrows the targets. Tests for
  refusals and for durability across a second resume.
- **2b, the delivery.** Rendering the answer into `previousAttempt`, clearing
  the canonical result for the answered attempt, and the end-to-end test.

**Done when** — deterministic, with the replay harness, no live model:
1. a run with a node blocked on context and a second blocked for another reason:
   `--answer` on the first re-dispatches only it, the second stays blocked.
2. the re-dispatched worker prompt contains the answer text under its own
   heading; so does the judge prompt for that attempt.
3. the node does not adopt its previous `blocked_context` result.
4. attempt increments exactly once.
5. without `--answer`, the node still stays blocked, unchanged.
6. resume twice with the same answer: one record per invocation of the flag,
   no duplicate dispatch of completed work.
7. an answer file above the ceiling, an unknown node id, and a node that is not
   blocked on context each refuse with their own message.
8. the answer survives a controller interruption: kill between the record and
   the dispatch, resume again, the answer is still delivered.
9. a node snapshot carrying an `operator-answer` override round-trips through
   `validateNodeSnapshot`, and one carrying an unknown override field is still
   rejected.

## Phase 3 — one command that says what to do

**Problem.** Finding the next action means `campaign list`, then `status`, then
`findings`, per open campaign.

**Change.** `next [--cwd <dir>] [--json]`, dispatched from `cli.mjs` with zero
positional arguments, rendering in `report/`. It reads only what `status` reads,
takes no lock and writes nothing.

**One line per open campaign**, chosen by the first predicate that matches, in
this order. The predicates are disjoint by construction because each is tested
only after the earlier ones failed:

| # | Predicate | Line |
| --- | --- | --- |
| 1 | a linked run has a non-terminal node and no live controller, whether the lock is stale, absent or unreadable | resume it, with the command |
| 2 | a node is `blocked` and its result is `blocked_context` | the worker's question, and the `resume --answer` template |
| 3 | a node is `exhausted` and its gate carries findings | the `findings` command |
| 4 | a node is in any other non-terminal-progress state: `blocked` for another reason, `failed`, `stalled`, `canceled`, or `exhausted` with no findings | the error code, and the `status` command |
| 5 | every linked run is terminal | closure eligibility, and whether a retrospective note exists |
| 6 | a run is live | one status line, nothing to do |

The previous draft's ranks 3 and 4 overlapped: `status` treats every state
except pending, running, done and no-op as attention, so an exhausted node
matched the generic rank before the specific one. The ranks above are ordered
specific-before-generic and rank 4 is defined by exclusion, so exactly one
matches any node.

Rank 4 also covers a run whose node snapshot or run metadata cannot be read or
parsed — a torn write, a corrupt JSON file, a permission error. This is not a
node status; it is a failure inside `next`'s own scan, and it is not gate
findings, so it does not belong in rank 3. The line names the path and the
underlying error, and still points at `status`, even though `status` will
fail on the same file: the diagnostic value is in `status`'s own longer
message, and `next` never widens its own read past a `try`/`catch` to work
around it.

Ordering across campaigns is by that rank, then by campaign id, so output is
stable. A campaign with no linked runs reports rank 5 with no runs. An
unreadable run artifact is reported as rank 4, per the paragraph above, never
skipped silently.

**Closure is never inferred.** Rank 5 reports eligibility and says whether
`campaign close` would refuse for want of a retrospective. It does not claim the
work is done.

**Commands versus templates.** A line carries a runnable command when every
argument is derivable from state. The `--answer` line is a template because the
answer file does not exist yet; it is marked as such and the JSON payload
carries `runnable: false`.

**Done when:**
1. a fixture with three campaigns, one blocked-on-context, one live, one wholly
   terminal, prints exactly three lines in rank order, asserted exactly.
2. an empty `.runs/` prints exactly one line saying nothing needs anyone. There
   is no silent mode; this replaces the contradictory wording in the previous
   draft.
3. `--json` emits `{schemaVersion: 1, items: [...]}` with one entry per line,
   each carrying campaign, rank, reason, command and `runnable`.
4. running `next` mutates nothing: a filesystem snapshot before and after is
   identical, including `.runs/status.json`.
5. arguments containing spaces are quoted in the rendered command.
6. a run with one node snapshot replaced by truncated JSON reports that node
   at rank 4, naming the path and the parse error, with the `status` command;
   it does not crash `next` and does not fall through to rank 5 or 6.

## Phase 4 — cost the operator declared

**Problem.** Four of five vendors report no cost, so cost aggregation counts
only the vendor that answers.

**Change.** An optional `runtimes[<id>].pricing` object, added to the runtime
field allowlist, with `inputPerMTok`, `cachedInputPerMTok`, `outputPerMTok`.
Each is optional and must be a finite number at least zero; an unknown key is
rejected; `pricing: {}` is rejected as meaningless rather than treated as free.

**Arithmetic**, on the canonical counters, which already exclude cached reads
from input and fold cache creation into input:

    costUsd = (inputTokens * inputPerMTok
             + cacheReadInputTokens * cachedInputPerMTok
             + outputTokens * outputPerMTok) / 1e6

**Incomplete data never becomes zero.** A cost is computed only when every rate
needed by a non-null counter is declared. A counter that is null with a declared
rate, or a non-zero counter with no rate, leaves the record `unknown` with
`costUsd: null`. A declared rate of exactly zero is a real price and does count.

**Precedence.** A harness-reported cost always wins and stays `provider`,
including a reported zero. Only when the harness reports none does a priced
runtime produce `costProvenance: "priced"`. A record already written is never
re-priced later; the ledger is append-only and `usage.mjs` already skips ids it
has recorded.

**Two source points, not five.** A `ProviderEnvelope` carrying a `costUsd`
field is first produced from a transcript in exactly two functions, and every
other place that reads `costUsd` afterward is downstream of one of them:

- **`run/usage.mjs`, `recordInvocationUsage`** — called from
  `engine/lifecycle.mjs`'s `finalizeClosedJobs` on every closed invocation,
  before any outcome-specific handling, including the `TERMINAL.has` early
  return and the worker scope-failure exit, neither of which reaches any later
  copy. This function's own invocation-mapping line — today `{ ...invocation,
  usage: envelope.usage }` — is therefore where the priced fields must be
  persisted, not only returned: it gains `costUsd: envelope.costUsd,
  costProvenance: envelope.costProvenance` in the same literal, alongside
  `usage`.
- **`engine/process.mjs`, `invocationResult`** — called from every branch of
  `engine/recover.mjs`'s `recoverOrphan` and from `rejudgeOrRestart`'s own
  worker-stream read, each already holding the correct `runtime` in scope.

**Price at the source, once, and let the object carry it.** Each of the two
functions calls the new pure `priceUsage(runtime, usage, reportedCostUsd)`
immediately after producing its envelope — in `recordInvocationUsage`, after
its existing live-usage backfill has run, since that backfill reassigns
`envelope` in place before this function returns it; in `invocationResult`,
right before it returns, since that function has no backfill step of its own
— and returns an envelope whose `costUsd`/`costProvenance` are already final.
Nothing downstream recomputes anything; every later `costUsd` reference in
`recover.mjs` or `lifecycle.mjs` is either:

1. **A spread of the now-priced object**, which needs no change at all —
   `recoverOrphan`'s four `{ kind: "adopted", ...terminal, ... }` /
   `{ kind: "adopted", ...result, ... }` branches, and its
   `{ kind: "exhausted", ...result, ... }` branch, already carry whatever
   `terminal`/`result` carries, `costProvenance` included, the moment
   `invocationResult` returns it primed.
2. **An explicit field copy that gains one sibling line.** Every place that
   today reads `costUsd: result.costUsd`, `costUsd: judgeResult?.costUsd`, or
   `costUsd: envelope.costUsd` gains `costProvenance:` from the identical
   source on the same or the next line: both of `recoverOrphan`'s inline
   judge-exhaustion object literals (the duplicated `{ kind: "exhausted",
   phase: "judge", ... }` shape appears twice, once at deadline and once past
   it — both need the addition); `restartRecovery`, which falls back to
   `invocation.costUsd` when no fresh result exists and whose
   `costProvenance` falls back to `invocation.costProvenance` the same way;
   `rejudgeOrRestart`'s two return literals; `adoptOrRejudgeJudge`;
   `recoveryFromOverride`, replaying a persisted decision; and
   `closePersistedInvocation`, which gains a `costProvenance` parameter
   mirroring its existing `costUsd` one.
3. **`lifecycle.mjs`'s `finalizeClosedJobs`, the live-path second write the
   fifth review round found.** After calling `recordInvocationUsage`, this
   function later rebuilds the same invocation with
   `{ ...invocation, continuationId, usage: envelope.usage, costUsd:
   envelope.costUsd }`. Once `recordInvocationUsage` persists
   `costProvenance` onto that invocation as described above, the `...invocation`
   spread here already carries it forward unchanged — the same value, since
   both reads trace to the same already-priced envelope — so the marker is
   not at risk of silent loss the way an earlier draft of this section
   claimed. The literal still gains an explicit `costProvenance:
   envelope.costProvenance` beside its `costUsd:` line, for the same reason
   every other site in this list does: so the field that decides `priced`
   versus `provider` is never one accidental refactor away from being the
   only field in an object that nobody spread. Three other cost references in
   this same function are explicitly out of the mechanical check below: the
   `settleInvocation(...)` calls that write `costUsd` into the operations
   ledger (a different record from the node invocation this phase's
   consumers read, with no provenance requirement of its own), and the
   `state.costUsd = invocationCost(state)` aggregation, which sums numbers
   already priced upstream and carries no provenance field itself.
4. **`engine/bulk-read.mjs`, `accountDelegation`**, which calls
   `normalizeProviderResult` directly and is not downstream of either source
   function. It gets its own explicit call: `priceUsage(runtime,
   envelope.usage, envelope.costUsd)` before building the ledger record.

**Persistence.** `contract/snapshot.mjs`'s invocation field allowlist gains
`costProvenance`, valid only as absent or the literal `"priced"`.
`run/usage.mjs`'s `appendUsageRecord` reads it first, falling back to its
current rule — a number is `provider`, absence is `unknown` — only when the
field is absent, so every invocation recorded before this phase reports
exactly what it reports today. `persistRecoveryUsage`'s existing `usage`/
`costUsd` merge is extended to select cost and provenance **together**, from
whichever source wins the existing numeric-cost predicate — never
independently, since an independent fallback could attach a stray
`recovery.costProvenance` to an already-settled `current.costUsd` that was
never priced at all:

    const priced = typeof current.costUsd === "number"
      ? { costUsd: current.costUsd, costProvenance: current.costProvenance }
      : { costUsd: recovery.costUsd ?? null, costProvenance: recovery.costProvenance };

included in the function's existing `changed` comparison and persisted
alongside `usage`.

**Verifiable, not just described.** Every file this phase touches —
`run/usage.mjs`, `engine/recover.mjs`, `engine/lifecycle.mjs`,
`engine/bulk-read.mjs` — has the property that every occurrence of `costUsd:`
in an object literal is either immediately preceded or followed by a
`costProvenance:` line reading from the identical source expression, or is
itself inside a `...spread` of a value this phase already primed. This is
mechanically greppable and is exactly what review at execution time checks: a
`costUsd:` with no accompanying `costProvenance:` and no spread ancestry is a
finding, not a style preference.

**What stays out of scope, named rather than implied.** A recovery branch
that restarts an invocation without ever reading a transcript — no reliable
close time, or the deadline passed with nothing to adopt — has no envelope to
price and correctly falls back to whatever `costProvenance` the invocation
already carried, nothing for a first attempt. This phase does not change
that: it is existing, correct behavior for genuinely unknown cost, not a gap.

A killed invocation whose terminal envelope leaves a counter null because the
live-usage backfill does not recover it — `recordInvocationUsage`'s backfill
restores `inputTokens`/`cacheReadInputTokens` from the live meter, not
`outputTokens`, so a Codex worker killed before any output token was counted
stays `{inputTokens: 600, outputTokens: null, cacheReadInputTokens: 0}` — is
correctly priced `unknown` by this phase's own rule: a null counter is a
missing measurement, never a zero contribution. Extending the live-usage
backfill to recover more counters for more harnesses is a separate,
harness-specific accuracy improvement and not part of this phase.

`bulk-read.mjs`'s delegation accounting is not made crash-safe by this phase:
its invocation id is generated only when `accountDelegation` runs, and the
observed usage lives only in the delegating process's memory until then. A
process killed before that point records nothing today and will record
nothing after this phase, with or without pricing. Making a delegation
durable across that crash window is a different change to a different module
and is not part of this one.

**Consumers.** `campaign/metrics.mjs` already counts any provenance that is not
`unknown`, so `priced` counts with no change; a test pins that. `evals/metrics.mjs`
computes `costPerClosedCheckpoint` and is the other consumer; a test pins it too.

**Done when**, with exact numbers, not "a cost appears":
1. 1,000,000 input, 500,000 cached, 200,000 output at 1.0 / 0.1 / 3.0 yields
   exactly 1.65 and `priced`.
2. the same runtime with a harness-reported 0.42 yields 0.42 and `provider`.
3. a harness-reported 0 stays 0 and `provider`, not recomputed.
4. no pricing declared: `null` and `unknown`.
5. a non-zero output counter with no `outputPerMTok`: `null` and `unknown`.
6. `pricing: {}`, a negative rate, a non-finite rate and an unknown key are each
   rejected at validation with their own message.
7. both metric consumers count a priced record.
8. the per-node cost column and the run total agree for a priced run: the node
   reads `known`, never `ambiguous`, and the two numbers are equal.
9. a recovered invocation (killed mid-turn, then adopted on resume) whose
   runtime declares pricing reports the identical `costUsd` and
   `costProvenance` on the first resume and on a second, repeated resume of
   the same run, exercising `persistRecoveryUsage`'s change-detection with the
   new field included.
9b. a recovered invocation whose transcript envelope carries complete,
   non-null usage counters (a fake provider under deterministic test control,
   not a live model) and a runtime with declared pricing is priced identically
   whether adopted on the first resume or re-read on a second, repeated one.
9c. a killed invocation whose envelope leaves `outputTokens` null after the
   existing live-usage backfill runs stays `costUsd: null`,
   `costProvenance` absent — not silently priced from a partial count, and not
   a defect this phase is required to fix.
10. a bulk-read delegation from a priced runtime is recorded in `usage.jsonl`
    with `costProvenance: "priced"`; it is not asserted anywhere against
    `costProjection`, which never sees it.
11. an invocation snapshot fixture from before this phase — `costUsd` a number,
    no `costProvenance` field — is read by `appendUsageRecord`'s rule
    unchanged: `provider`.

## Delivery

Every phase boundary runs, and must pass: the named deterministic tests, the
whole suite, `npm run typecheck`, `evals/run.mjs --class deterministic
--assert-no-model`, and `--verify-discriminating`. No acceptance criterion
anywhere in this spec depends on a live model reaching `done`.

Every node ships with a closed packet naming exact read files, write files,
decisions, non-goals and verification commands. The work lands on `main`.
