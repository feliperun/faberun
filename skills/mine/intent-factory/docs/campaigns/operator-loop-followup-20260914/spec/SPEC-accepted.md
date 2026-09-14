# Spec v6: follow-up from operator-loop-20260913's retrospective

Fourth round returned ACCEPT WITH CHANGES: all four issues from round 3 are
confirmed resolved (verified independently this round, live, against the
running code: schema rejections for `invocation.cycle`/`routing.tierExhaustion`
reproduced before the fix; the supervisor baseline probed with tier
exhaustion, missing-context, and an arbitrary block reason, all reporting
`"done"`; both `recover.mjs` judge branches and the `resume.mjs` envelope
exercised with mocked provider/process observations; the ledger's eager
`"provider"` write confirmed with the write sink mocked). One new regression
was found in v4's own cleanup rule, reproduced live this round:

- **Cleanup deleted the generation counter alongside the evidence it was
  meant to make safe to lose.** v4's `routing.tierExhaustion` cleanup rule
  removed the whole object — including `cycle` — whenever an unrelated
  block reason or outcome intervened. Reproduced sequence: cycle 0 exhausts
  A, B, C; Phase 1b starts cycle 1; C hops to A, which blocks on
  `context_missing` (unrelated); v4's cleanup rule fires and removes
  `tierExhaustion` (`cycle` included); an operator resolves it with `resume
  --answer` (`revisions`/invocations untouched); A exhausts again — and
  `planRoute`'s cycle expression, reading a now-absent field, defaults back
  to the implicit **0**, so the *original* cycle-0 invocations (A, B, C) once
  again count as "attempted," wrongly excluding B and C that cycle 1 had
  already legitimately reached. Confirmed live by applying the cycle filter
  in memory to `planRoute`: before cleanup, cycle 1 correctly routes to B
  with no block; after the intervening cleanup and unrelated retry, the same
  state recomputes as cycle 0 and re-blocks as `runtime_tier_exhausted`,
  with `revisions` unchanged throughout the whole sequence.

The fix, below: separate the generation counter from the evidence it
governs, so clearing one never clears the other.

Round 5 confirmed that split correct (the round-4 sequence traced through
`planRoute`/`nextSameTierRuntime`/`synthesizedChain`/`transition` at HEAD,
reaching B in generation 1 where v4 re-blocked), confirmed the four round-3
issues still resolved, and found no defect in the split itself. It returned
ACCEPT WITH CHANGES for exactly one unlisted schema edit, plus three wording
notes. All four are folded in below and marked **round 5**; everything else
is unchanged from v5, which is unchanged from v4 and v3 except where marked.

## Phase 1a — durable exhaustion evidence that survives its own hops

**Change.** Two sibling fields on `routing`, not one — this is the split
issue #5 requires, corrected this round:

    tierExhaustion: { role: "worker"|"judge",
                       candidates: {runtimeId: string, exhaustedUntil: string|null}[] }
    tierExhaustionCycle: number

`tierExhaustion` (the *evidence*: which candidates this generation has tried
and when each resets) is appended to at both intermediate hops
(`engine/backoff.mjs`'s `planRoute`, upserting by `runtimeId` so a repeated
wait on the same candidate does not duplicate it) and the final blocking
transition (`engine/lifecycle.mjs`'s `handleProviderExhaustion`, appending
`current`'s own `exhaustedUntilOf(envelope)` before it sets `state.error`).
`tierExhaustionCycle` (the *generation counter* used for invocation
exclusion) starts at `0` implicitly (absent) and increments by exactly one
each time Phase 1b dispatches a `"retry"`/`"rejudge"` *for a
`runtime_tier_exhausted` reason* — never for any other reason, and never by
`planRoute`'s own intra-cycle hops. No other event ever changes it.

**`buildRouting` gains the fix round 2 asked for as a side effect of gaining
this one.** Its returned `routing` object spreads `state.routing` first,
`{...state.routing, history: [...], currentOverride: override}` — this is
what makes `assignments`/`availability` (round 2's #2) and `tierExhaustion`/
`tierExhaustionCycle` (this phase's own fields) survive a hop; today's object
literal replaces the whole thing and drops all of them. `handleProviderExhaustion`'s
own blocked-transition (which does not call `buildRouting` at all) sets
`routing: {...state.routing, tierExhaustion: {...}}` explicitly the same way.

**Cycle-scoped exclusion, not revision-scoped, for tier routing specifically.**
`planRoute`'s `attempted` computation gains an additional filter dimension:
an invocation counts as attempted for *this* tier-exhaustion decision only
when its own recorded cycle (stamped onto the invocation the same way
`revision` already is, at dispatch time) matches
`state.routing?.tierExhaustionCycle ?? 0`. A fresh generation (after Phase 1b
retries) starts with an empty attempted set for tier-routing purposes,
independent of `revision`, which keeps its existing, unrelated meaning
(bounding a judge-rejection round) untouched. **Scope of the filter (round
5):** it applies to the single `attempted` set `planRoute` already computes,
which every consumer of that set reads — so a declared `fallback` candidate
attempted in generation 0 becomes reachable again in generation 1 too, still
bounded by the existing hop cap. That is intended, not incidental: a new
generation means every candidate's exhaustion evidence is stale, not only
the same-tier candidates'.

**Schema (issue #1, corrected again this round for issue #5's split).** Three
things reject unknown fields today and must be extended: `contract/snapshot.mjs`'s
invocation field allowlist (currently `exitCode/signal/status/executable/
usage/usageEstimated/costUsd/costProvenance/snapshotPath/revision`) gains
`cycle`, validated the same way `revision` already is (`nonNegativeInteger`,
optional — absent means cycle 0, matching `tierExhaustionCycle`'s own
implicit-zero rule). `validateRoutingState`'s allowlist (currently
`history/currentOverride/assignments/availability`) gains **two** fields, not
one: `tierExhaustion`, validated as an object with `role` (`"worker"|"judge"`)
and `candidates` (array of `{runtimeId: string, exhaustedUntil: string|null}`,
`requireId`/`requireTimestamp`-when-non-null per entry, same pattern
`ERROR_FIELDS` already uses) — no `cycle` inside it any more; and
`tierExhaustionCycle` (`nonNegativeInteger`, optional, sibling to
`tierExhaustion`, not nested in it). This is the concrete edit done-when case
6 requires, not a separate promise. Phase 3 carries one further schema edit
of its own, to `validateRoutingEntry`'s two field sets — listed there, and
independent of this phase.

**Reset semantics (issue #1, corrected again this round for issue #5's
split).** Incrementing the generation (at the single dispatch point Phase 1b
defines, below) is two separate writes, not one: `routing.tierExhaustionCycle`
becomes `previous + 1` — a bare integer bump, never reset to a smaller value,
never removed by anything — and `routing.tierExhaustion` is replaced
wholesale with `{role, candidates: []}`, never `{...previous, candidates:
[]}`, so the new generation's `candidates` starts empty rather than carrying
the prior generation's entries forward for `planRoute` to upsert into. An
implementation that only ever appends/upserts and never clears `candidates`
could still satisfy a re-exhaustion of every candidate (every old entry gets
overwritten in place by the upsert rule), which is why Phase 1b's done-when
case 8 is strengthened below rather than trusted as v3 worded it.

**Cleanup on an unrelated outcome (issue #1, corrected this round —
issue #5, the round-4 defect).** `routing.tierExhaustion` — the evidence
object only — is cleared (the field removed entirely, not left stale)
whenever a node reaches any transition this phase does not itself drive: a
different block reason, an ordinary success, a judge rejection, or any other
terminal or non-tier outcome. **`routing.tierExhaustionCycle` — the
generation counter — is never touched by this cleanup, under any
circumstance.** v4 cleared both together; that is exactly what let the
generation silently fall back to its implicit-`0` default the moment a
later, unrelated exhaustion occurred, resurrecting a stale, already-superseded
generation's invocations as "attempted" against candidates the *current*
generation had never actually tried. Keeping the counter outside the cleared
object is what prevents this: cleanup only ever removes evidence that is
safe to lose (which candidates were tried this generation, and their reset
times), never the count that says which generation is current — the counter
is append-only for the lifetime of the node, exactly like `revisions` already
is. After cleanup has removed `tierExhaustion`, a later exhaustion hop simply
re-creates it through the same upsert rule that populates it in the first
place — the field is absent, not tombstoned, and nothing special-cases its
re-creation (round 5).

**Done when:**
1. a three-candidate exhaustion (A, B hopped through, C the final block)
   leaves `routing.tierExhaustion.candidates` with all three, in order,
   surviving both intermediate dispatches — proven by asserting the list
   *during* the sequence, not only at the end.
2. `buildRouting`'s return preserves `state.routing.assignments` and
   `.availability` unchanged across a hop, with a regression test that fails
   without the spread.
3. after Phase 1b retries at cycle 1, a fresh exhaustion re-walks A, B, and C
   again — none excluded by the cycle-0 invocations — proving the
   cycle-scoped filter, not the revision-scoped one, governs tier attempts.
4. `state.revisions` is unchanged by a tier-exhaustion retry; a judge
   rejection on an unrelated attempt still increments it exactly as today,
   proving the two counters do not interfere.
5. a node blocked for any other reason carries no `tierExhaustion` field at
   all.
6. `validateNodeSnapshot` round-trips `routing.tierExhaustion` and
   `routing.tierExhaustionCycle` and rejects an unknown field inside either;
   an invocation carrying `cycle` round-trips too, and one with an unknown
   field is still rejected.
7. a node that resolves for an unrelated reason after previously carrying
   `tierExhaustion` evidence (a different block reason on the next attempt,
   or an ordinary success) no longer carries the `tierExhaustion` field at
   all — but `routing.tierExhaustionCycle` is unchanged by that same
   transition, proving cleanup removes only the evidence.
8. **new (issue #5, round 4's finding):** the full reproduced sequence —
   cycle 0 exhausts A, B, C; Phase 1b starts cycle 1; C hops to A; A blocks
   on an unrelated reason (`context_missing`); the cleanup rule removes
   `tierExhaustion`; the node is resolved for that unrelated reason
   (`resume --answer` or equivalent, `revisions`/invocations untouched); A
   exhausts again for the tier reason — asserts `routing.tierExhaustionCycle`
   still reads `1` (never fallen back to the implicit `0`), so `planRoute`
   correctly excludes only cycle-1's own already-tried invocations and
   routes to B, never re-blocking on a stale cycle-0 exclusion set.

## Phase 1b — hold before the earliest reset, retry the right phase and target after

**Change**, from v2, corrected for round 2's #5:
`retry.mjs`'s `classify` branch for `runtime_tier_exhausted` computes the
earliest instant from `routing.tierExhaustion.candidates` (this phase no
longer reads `state.error.exhaustedUntil` for this decision — Phase 1a's list
already includes the final candidate). Below the target-closure checks the
existing `"retry"` branch already applies:

    if (state.status === "blocked" && state.error?.code === "runtime_tier_exhausted") {
      const earliest = Math.min(...candidates.map(c => Date.parse(c.exhaustedUntil ?? "")).filter(Number.isFinite));
      if (!Number.isFinite(earliest)) return hold(node, "no recorded reset time for any exhausted candidate");
      if (Date.now() < earliest) return hold(node, `earliest recorded reset is ${new Date(earliest).toISOString()}`);
      if (targets && !targets.has(node)) return hold(node, "it is outside the `--node` retry");
      return state.phase === "judge" ? "rejudge" : "retry";
    }

placed alongside the existing checks, applying the *same* `targets` guard
`"retry"`'s own branch already has (round 2's probe found the v2 draft's
snippet skipped it, retrying an unrelated exhausted node under an unrelated
`--node`). The dependent-reopening check at `retry.mjs:153`
(`actions.get(id) === "retry" || states.get(id)?.status === "done"`) gains
`"rejudge"` beside `"retry"` in its action check; the status half of the
condition is untouched. (v5 also asked for a correction to a code comment
about that condition. Round 5 found no such comment at HEAD, so there is
nothing to correct and that instruction is withdrawn — the substantive edit
above stands on its own.)

The point where `"retry"`/`"rejudge"` dispatch (in `resume.mjs`) is where the
generation advances: `routing.tierExhaustionCycle` increments by one, and
`routing.tierExhaustion` is (re)written to `{role, candidates: []}`, in the
same write — two fields, one dispatch point, per Phase 1a's own split
(corrected this round for issue #5).

**Self-pacing (unsupported claim from v2 removed).** v2 asserted a provider's
own reported reset never repeats a past instant; round 2 called this
unsupported and asked for it removed rather than relied on. Removed. The
actual bound is external: Phase 1c below calls `resume` at most once per its
own poll interval, which is the only thing bounding retry frequency if a
provider's hint is stale or wrong.

**Done when**, from v2 unchanged except as noted:
1. worker-tier exhaustion past its earliest reset retries as `"retry"`, phase
   worker.
2. the same 5 minutes before its reset holds, reported in `plan.attention`.
3. judge-tier exhaustion past its reset retries as `"rejudge"`, preserving
   `state.result`.
4. the four other blocked reasons classify exactly as today, one test each.
5. a dependent reopens for `"rejudge"` exactly as it already does for
   `"retry"`/dependency-`"done"`.
6. all-null `exhaustedUntil` holds indefinitely (`Number.isFinite` guard).
7. `--node` naming an unrelated node holds *this* exhausted node
   regardless of its own deadline having passed — the target-closure guard
   applies to this branch the same as `"retry"`'s own.
8. a node retried once (cycle 1) that exhausts every candidate again:
   immediately after the cycle-restart dispatch, `routing.tierExhaustion.candidates`
   is asserted **empty** (`routing.tierExhaustionCycle === 1`, zero
   candidate entries) before any candidate is retried again — not merely
   equal to some non-empty set — and a **second**, smaller subsequent cycle
   (visiting fewer candidates than cycle 1, e.g. two of three) computes its
   own earliest strictly from those two, proving an obsolete deadline from a
   prior, larger cycle cannot linger and influence the result. An
   implementation that only ever appends/upserts without ever clearing
   `candidates` must fail this test, where it could have passed the
   original wording.

## Phase 1c — `supervise` notices and calls `resume` once, at the right time

**Baseline (issue #2, confirmed this round).** Today, `blocked` is
unconditionally in `TERMINAL` in `engine/supervise.mjs`, for *every* block
reason — independently reprobed this round with tier exhaustion, missing
context, and an arbitrary block reason, all three reporting `"done"` when the
other node in the run was terminal. `"waiting"` is new behavior added
*instead of* `"done"`, for exactly one case: a `runtime_tier_exhausted` node
whose earliest recorded reset is computable and still in the future. It is
not a refinement of `"unfinished"`, and `"unfinished"` is not today's general
behavior for other block reasons — `"unfinished"` only ever describes a
*different*, non-terminal node elsewhere in the same run; it has nothing to
do with a blocked node's own reason.

The done-when list is unchanged from v2 except the last case, which is
corrected to match: a `runtime_tier_exhausted` node with unknown/missing
evidence (no computable earliest instant — Phase 1b's own hold case) is left
classified exactly as today — `blocked` stays in `TERMINAL`, the run reports
`"done"` when every other node is also terminal — never `"waiting"` with
nothing to wait for, and never a new `"unfinished"` this phase does not
otherwise produce.

**Past reset, stated rather than left derivable (round 5).** A
`runtime_tier_exhausted` node whose earliest recorded reset is computable and
already *past* does not report `"waiting"`: it reports `"unfinished"`, so
`superviseRun` makes the ordinary `launch` call and Phase 1b then dispatches
the retry. Whenever both could describe the same node, `"unfinished"`
outranks `"waiting"` — `"waiting"` means only "there is a known future
instant and nothing to do until it arrives".

**Done when:**
1. a run with only a `runtime_tier_exhausted` node whose earliest reset is in
   the future reports `RunProgress.state === "waiting"` and `superviseRun`
   does not call `launch`, proven with a fake clock, not a real wait.
2. once the fake clock passes that instant, the next tick calls `launch`
   exactly once.
3. a run with both a `"waiting"` node and an unrelated `"unfinished"` one
   calls `launch` on the ordinary schedule regardless of the waiting node.
4. a live controller on the run is left alone exactly as today —
   `"waiting"` never triggers a launch while a controller is already alive.
5. a run with only a `runtime_tier_exhausted` node whose evidence is
   missing/unknown (no candidate has a parseable `exhaustedUntil`) reports
   `RunProgress.state === "done"` when every other node is terminal — the
   pre-existing baseline, unchanged by this phase — never `"waiting"` and
   never `"unfinished"`.

## Phase 2 — `next`'s rank 5 stops counting absence as terminal

Unchanged from v2, already accepted as revised.

## Phase 3 — price `bulk-read`'s own returned envelope, matching the existing convention

**Corrected for round 2's #8, corrected again for round 3's issue #4,
confirmed this round.** The existing, already-shipped convention in
`run/usage.mjs` is precise and asymmetric between the two objects it governs,
not identical between them: `appendUsageRecord` (the ledger writer, confirmed
this round with its write sink mocked) computes `costProvenance:
invocation.costProvenance ?? (typeof invocation.costUsd === "number" ?
"provider" : "unknown")` and writes that value — including the literal
string `"provider"` — into the persisted `usage.jsonl` record eagerly, at
write time. This is existing, correct, shipped behavior; nothing in this
phase changes it. What must change is that any *freshly constructed result
object* (`bulkRead()`'s own returned result, in particular) follows the
*other* half of the same convention: `costProvenance` present only as
`"priced"`, and otherwise **absent** — never independently computing or
assigning the literal string `"provider"` itself, since only
`appendUsageRecord`'s existing rule does that, and only for the ledger.
`bulkRead()`'s returned result and its ledger entry therefore legitimately
end up carrying *different* values for the same provider-reported case:
`costProvenance` absent on the result, `"provider"` in the ledger record —
this is the correct target, not a contradiction.

**Recovery-path ingress (issue #3, confirmed this round with both judge
branches exercised against mocked provider/process observations — three
sites).** The synthetic exhaustion envelope `resume.mjs` builds when adopting
a crashed invocation (`resume.mjs:207`, no `exhaustedUntil` at all), and two
distinct branches in judge recovery (`recover.mjs:129`, and `recover.mjs:155`'s
ordinary closed-judge-invocation branch — returns `{kind: "exhausted", phase:
"judge", invocationId: invocation.id, usage: result.usage, costUsd:
result.costUsd, costProvenance: result.costProvenance, error: result.error,
reason: result.error?.message}`, forwarding `costProvenance` but no
top-level `exhaustedUntil`) all drop deadline evidence today. Normalize all
three: each carries forward whatever `exhaustedUntil`/provenance the
underlying recovered result actually had (`recovery.error`/`invocation`'s own
recorded fields, when present) into the envelope `handleProviderExhaustion`
receives, so Phase 1a's `tierExhaustion` recording sees real evidence when it
exists, and correctly records `exhaustedUntil: null` (never a wrong guess)
when it does not.

**Delivery independence (issue #3, confirmed this round).** Restricting the
routing-cost assertion (case 4 below) to `routing.history`/
`routing.currentOverride` only removes any Phase-1a dependency from this
phase's own done-when list, so the Delivery section's independence claim
holds as intended.

**Schema for the routing-entry provenance field (required, round 5).**
`contract/snapshot.mjs`'s `validateRoutingEntry` rejects unknown fields
against two separate allowlists — the override set (`at`, `role`, `runtime`,
`nextRuntime`, `rule`, `ruleIndex`, `revision`, `hop`, `reason`,
`backoffSec`, `backoffUntil`, `usage`, `costUsd`) and the non-override set
(the same, with `status`/`errorCode` in place of `reason`) — and neither
admits `costProvenance` today, so case 4 below is unpersistable without this
edit. Both sets gain `costProvenance`, optional, validated as the literal
`"priced"` when present and absent otherwise, matching the convention above.
`RoutingHistoryEntry` and `RoutingOverride` in `contract/index.mjs` gain the
field in their typedefs the same way. This edits a validator that already
exists at HEAD and introduces no dependency on Phase 1a.

**Done when:**
1. a priced runtime's successful `bulkRead()` result carries
   `costProvenance: "priced"`; its ledger record carries the identical value.
2. a priced runtime's failed delegation result also carries it.
3. a runtime with a provider-reported cost has `costProvenance` **absent** on
   the returned result object (never the literal string `"provider"`,
   assigned nowhere by this phase's own code) but its ledger record carries
   the literal string `"provider"`, written by `appendUsageRecord`'s
   existing, unchanged rule — the two objects legitimately differ for this
   one case, matching `test/engine/bulk-read.test.mjs:181`'s existing
   assertion of the ledger convention.
4. a `routing.history`/`routing.currentOverride` entry for a priced runtime
   carries `costProvenance: "priced"`; one for a provider-reported cost does
   not — scoped to these two routing fields only. `tierExhaustion.candidates`
   entries (`{runtimeId, exhaustedUntil}`) carry no cost field at all and are
   not a target of this assertion.
5. **new (round 5):** a `routing.history` entry and a
   `routing.currentOverride` entry each carrying `costProvenance: "priced"`
   round-trip through `validateNodeSnapshot`, and one carrying an unknown
   field is still rejected — proving both allowlists were extended, not only
   one.
6. a node recovered from a crashed invocation that was mid-exhaustion carries
   the same `exhaustedUntil` evidence a live run would have recorded, proven
   with a recovery-path test exercising all three sites named above:
   `resume.mjs`'s worker-recovery site and both of `recover.mjs`'s
   judge-recovery sites.

## Delivery

Unchanged from v2: every phase boundary runs its named deterministic tests,
the whole suite, typecheck, and the deterministic evals. Phase 1a, 1b, 1c are
sequential closed packets; phase 2 and 3 are independent of phase 1 and of
each other.
