# Field ownership in the append-only event records

Every field of an append-only record has one declared writer and one moment at
which it is written. The model comes from SwarmForge: `created_at` belongs to
the emitter, `enqueued_at` to the daemon, `dequeued_at` to acceptance,
`completed_at` to completion. One owner, one moment. The point is not tidiness:
when two places can write the same field, nobody reading the record can say
which one won, and a later change to one of them silently changes the meaning of
the line.

This tree has two append-only event records, and both are declared here:

- **`events.jsonl`** — a run's node transition events, appended by
  `appendTransitionEvent` in `src/engine/state.mjs`, plus a small number of
  diagnostics appended directly by `src/engine/run-identity.mjs`,
  `src/engine/notify-queue.mjs` and `src/engine/process.mjs`.
- **`journal.jsonl`** — a campaign's material events, appended through
  `appendJournal` in `src/campaign/journal.mjs` by the emitters that build each
  event type.

Alongside them, the campaign record `campaign.json` is declared for the fields
that carry persisted closure content. It is rewritten whole by each mutator
rather than appended to, so it has no per-field ratchet: a declared field names
the one mutator that sets it and the one moment it is set.

The machine-readable block at the end of this file is the source of truth for
these records. `test/campaign/field-ownership.test.mjs` — the test named `single
writer per field` — re-derives every writer from `src/` and fails when the
derivation disagrees with this document. The document is the declaration; the
test is what keeps it from becoming fiction on the third change.

**Measured 2026-09-20 against this tree:** 32 `events.jsonl` fields and 16
`journal.jsonl` event types. Fifteen entries have more than one writer today.
Those fifteen are the ratchet at the end of this file; they are declared, not
fixed, because changing who writes a field is a behavior change and belongs to
another node. The stale-group signal guard added the one new ratchet field,
`invocationId`, on 2026-09-16. The seat-allowance-delta node added the one new
event type, `seat.allowance`, on 2026-09-17, behind a single writer function
so it does not grow the ratchet. The requirement-ids node added the one new
single-writer field, `requirementIds`, on 2026-09-20 — the engine stamps the
node's inherited phase requirement ids onto the snapshot when its result is
accepted, and `appendTransitionEvent` copies them — so the ratchet stays at
fifteen.

A type or field nothing writes is not declared here. This document is a
declaration of owners, and a field with no writer has no owner to declare.

## `events.jsonl`

The canonical writer is `appendTransitionEvent` (`src/engine/state.mjs`). It
stamps the record shape, copies the transition's identity and status from the
node snapshot, and spreads the caller's `details` last. Every field is listed
with every writer the tree has today; a field with more than one writer is
marked **(ratchet)**.

| field | writer(s) | written when |
| --- | --- | --- |
| `schemaVersion` | `appendTransitionEvent`, `assertEnvironmentReady` **(ratchet)** | at append, from the protocol constant; the preflight event stamps its own |
| `contractVersion` | `appendTransitionEvent`, `assertEnvironmentReady` **(ratchet)** | at append, from the version constant; the preflight event stamps its own |
| `at` | `appendTransitionEvent`, `assertEnvironmentReady`, `renderCampaignHandoffSafely`, `recordIdentityUnverifiable` **(ratchet)** | at append, from `state.updatedAt` (set by `transition`); the three diagnostics take `new Date().toISOString()` |
| `node` | `appendTransitionEvent` | at append, from `state.id` |
| `sourceIdentity` | `appendTransitionEvent` | at append, from the snapshot |
| `packetHash` | `appendTransitionEvent` | at append, from the snapshot |
| `from` | `appendTransitionEvent` | at append, the transition origin passed by `transition` |
| `to` | `appendTransitionEvent` | at append, the transition destination passed by `transition` |
| `phase` | `appendTransitionEvent` | at append, from `state.phase` |
| `attempt` | `appendTransitionEvent` | at append, only when `state.attempt` is set |
| `runtime` | `appendTransitionEvent` | at append, only when `state.runtime.id` is set |
| `error` | `appendTransitionEvent`, `renderCampaignHandoffSafely` **(ratchet)** | at append, `state.error.code` when set; the handoff diagnostic stores its message there |
| `verdict` | `appendTransitionEvent`, `settleAdvisoryReview` **(ratchet)** | at append, `state.gate.verdict` when set; `settleAdvisoryReview` also passes it in `details`, and the spread wins |
| `summary` | `appendTransitionEvent`, `settleAdvisoryReview` **(ratchet)** | at append, `state.gate.summary` when set; the advisory detail is spread over it |
| `revisions` | `appendTransitionEvent` | at append, `state.revisions` when set |
| `requirementIds` | `appendTransitionEvent` | at append, `state.requirementIds` when set — the phase requirement ids the engine stamped onto the node when its result was accepted |
| `invocationId` | `appendTransitionEvent`, `recordIdentityUnverifiable` **(ratchet)** | at append, the last invocation's id when set; the identity guard records the invocation it declined to signal |
| `pid` | `recordIdentityUnverifiable` | when a signal is withheld because the invocation's process identity cannot be proven |
| `processGroupId` | `recordIdentityUnverifiable` | when a signal is withheld because the invocation's process identity cannot be proven |
| `override` | `recordExecutionOverride`, `applyRoute` **(ratchet)** | when an execution override is recorded; when a route is applied |
| `recovery` | `ensureTerminalEvent`, `recordExecutionOverride` **(ratchet)** | when a terminal side effect is replayed; when an override carries a recovery note |
| `role` | `applyRoute`, `autoRetryNode` **(ratchet)** | when a route is applied; when a node earns its one automatic retry |
| `status` | `applyRoute` | when a route is applied |
| `currentRuntime` | `applyRoute` | when a route is applied |
| `errorCode` | `applyRoute`, `autoRetryNode` **(ratchet)** | when a route is applied; when a node earns its one automatic retry |
| `unexpectedPaths` | `checkWorkerScope`, `checkPersistedWorkerScope`, `recordScopeFinding` **(ratchet)** | when a scope check fails or an advisory finding is recorded |
| `unexpectedPathCount` | `checkWorkerScope`, `checkPersistedWorkerScope`, `recordScopeFinding` **(ratchet)** | when a scope check fails or an advisory finding is recorded |
| `type` | `recordScopeFinding`, `settleAdvisoryReview`, `assertEnvironmentReady`, `renderCampaignHandoffSafely`, `autoRetryNode`, `recordIdentityUnverifiable` **(ratchet)** | each diagnostic sets its own discriminator; there is no single owner today |
| `contractId` | `assertEnvironmentReady` | when the environment preflight fails |
| `ok` | `assertEnvironmentReady` | when the environment preflight fails |
| `checks` | `assertEnvironmentReady` | when the environment preflight fails |
| `campaignId` | `renderCampaignHandoffSafely` | when rendering the campaign handoff fails |

## `journal.jsonl`

The writer of each event is the emitter that builds it: `initializeCampaign`,
`closeCampaign` and `registerRun` in `src/campaign/index.mjs`; `attach`, `note`,
`resolveQuestion` and `attachSessionOnceDaily` in `src/cli/campaign.mjs`;
`appendSeatAllowanceEvent` in `src/campaign/journal.mjs` itself, called by both
`init` (`src/cli/campaign.mjs`) and `runPlanningPipeline`'s freeze stage
(`src/plan/pipeline.mjs`) so the two call sites share one writer instead of
each building the literal itself. The field set of each type is the one
`ENTRY_SHAPES` accepts in `src/campaign/journal.mjs`; it is listed here so the
document and the schema cannot drift apart.

| event type | writer(s) | fields | written when |
| --- | --- | --- | --- |
| `campaign.initialized` | `initializeCampaign` | `at`, `type`, `eventId` | when the campaign directory is created |
| `campaign.closed` | `closeCampaign` | `at`, `type`, `eventId` | when a campaign with a retrospective is closed |
| `campaign.unparked` | `unparkCampaign` | `at`, `type`, `eventId`, `code`, `runId` | when campaign unpark clears a parked campaign |
| `run.registered` | `registerRun` | `at`, `type`, `eventId`, `runId` | when a run is linked to the campaign |
| `session.attached` | `attach`, `attachSessionOnceDaily` **(ratchet)** | `at`, `type`, `eventId`, `sessionId`, `tool`, `transcript`, `transcriptUnavailable`, `format`, `cursor` | explicitly on `campaign attach`; implicitly once a day on sync |
| `intent` | `note` | `at`, `type`, `eventId`, `sessionId`, `text` | when a note of that kind is recorded |
| `decision` | `note` | `at`, `type`, `eventId`, `sessionId`, `decisionId`, `text` | when a note of that kind is recorded |
| `supersede` | `note` | `at`, `type`, `eventId`, `sessionId`, `supersedes`, `text` | when a note of that kind is recorded |
| `constraint` | `note` | `at`, `type`, `eventId`, `sessionId`, `text` | when a note of that kind is recorded |
| `outcome` | `note` | `at`, `type`, `eventId`, `sessionId`, `text`, `runId` | when a note of that kind is recorded, `runId` only when given |
| `next` | `note` | `at`, `type`, `eventId`, `sessionId`, `text` | when a note of that kind is recorded |
| `open-question` | `note` | `at`, `type`, `eventId`, `sessionId`, `questionId`, `text` | when a note of that kind is recorded |
| `question.resolved` | `resolveQuestion` | `at`, `type`, `eventId`, `sessionId`, `questionId`, `text` | when `campaign note --resolve` runs |
| `operator.command` | `recordOperatorCommand` | `at`, `type`, `eventId`, `command`, `sessionId`, `runId` | when a campaign-changing operator command is recorded |
| `retrospective` | `note` | `at`, `type`, `eventId`, `sessionId`, `text` | when a note of that kind is recorded |
| `seat.allowance` | `appendSeatAllowanceEvent` | `at`, `type`, `eventId`, `sample`, `harness`, `remaining`, `limit`, `resetsAt`, `delta`, `window` | when `campaign init` samples the operator's own seat allowance at campaign start (`sample: "start"`, `harness` from env-marker detection, `delta: null`), and when `plan freeze` re-samples that exact same harness (not the plan's worker runtime) at plan freeze (`sample: "freeze"`, `delta` against the start sample, or `null` with no start entry to compare against); `window` names the rate-limit window the sample measured (claude's `rateLimitType`, e.g. `"seven_day"`), so a delta across two differently-governed windows can be told apart from a real one |

## `campaign.json`

The campaign record is rewritten whole by every mutator (`initializeCampaign`,
`closeCampaign`, `registerRun`, `recordPromotion`, `parkCampaign`,
`addContractToCampaign` and `replaceContractInCampaign` in
`src/campaign/index.mjs`), so unlike the append-only records it has no
derivation-backed field list: only the fields declared below are owned here,
and the enforcing test checks each declared field's writer against the object
the mutator writes. The section grows by declaration.

| field | writer(s) | written when |
| --- | --- | --- |
| `requirements` | `closeCampaign` | at close: one entry per requirement id the linked runs' contracts declared, correlated only by the identifiers the runs carried (a done node snapshot's stamped `requirementIds`, never requirement text), each covering node named with its run and its verification evidence; a requirement no done node carries is recorded with status `open` instead of being omitted |

## The runtime catalogue record

Availability is state, rewritten whole by each discovery pass rather than
appended to, so like `campaign.json` it has no per-field ratchet: a declared
field names the one writer that sets it and the one moment it is set. One
record per runtime id. The shape is declared by `RuntimeAvailability`
(`src/engine/runtime-discovery.mjs`), `validateRuntimeAvailability`
(`src/contract/runtime.mjs`) is what a copy must pass before it enters a
routing decision, and `isRuntimeAvailable`
(`src/engine/runtime-discovery.mjs`) is the one reader that decides admission
from it — plan routing and engine composition share that reader, so the null
and staleness rules cannot drift between them.

The observability contract the readers and the validator enforce: an
unobservable datum is null — never zero, which would read as spent, and never
full allowance, which would read as rested — and an observation older than its
own window reads as unknown.

| field | writer(s) | written when |
| --- | --- | --- |
| `available` | `normalizeProviderAvailability` (`src/harnesses/index.mjs`) | when a probe envelope or a failed attempt's envelope is classified |
| `exhaustedUntil` | `normalizeProviderAvailability` (`src/harnesses/index.mjs`) | at that classification: the reset instant the provider wording carries, else null — an exhaustion that names no reset reads as unknown, not as rested |
| `reason` | `normalizeProviderAvailability` (`src/harnesses/index.mjs`) | at that classification |
| `observedAt`, `window`, `remaining` | the one harness that exposes each, at its own classification moment | no writer in `src/` fills them yet, so every record carries them as null today; the measured precedent is claude's `rate_limit_event` allowance extractor (`extractClaudeAllowance`, `src/harnesses/protocol.mjs`), which already writes `window` (`rateLimitType`) and `remaining` (`1 - utilization`) at envelope level, and discovery's pass is where `observedAt` lands when a producer first stamps it — the run-state field set that `contract/snapshot.mjs` accepts carries the three classified fields only until that producer exists |

## Routing assignment records

Routing produces two assignment records, and both are state rewritten whole by
their one producer rather than appended to, so like `campaign.json` they have
no per-field ratchet. Each records, per role, the strategy that was applied and
the reason for the choice — `declared` with the declaring field when an
operator instruction prevailed over the table and every strategy, the named
strategy's own rationale otherwise, and the inert fallback when a strategy
stood aside for want of an observable datum. The strategy vocabulary itself is
`ROUTING_STRATEGIES` (`src/contract/runtime.mjs`), validated protocol surface
like the harness names.

| record | field | writer | written when |
| --- | --- | --- | --- |
| plan routing (`RoutingAssignment`, `src/plan/routing.mjs`) | `strategy`, `reason` | `resolveRuntimes` | at plan routing resolution: the strategy the matching rule named (or the `priority` default), why the chosen candidate won or which datum left the strategy inert, and `declared` with the operator source for roles an override or `runtimeDefaults` named |
| engine composition (`decisions`, `runtimeAssignments`, `src/engine/assignment.mjs`) | `strategy`, `reason` | `runtimeAssignments` | at run creation and resume composition: `declared` with `node runtime`, `gate runtime` or `runtimeDefaults.<role>` for roles the contract named; `cost`/`priority` with the discovery ranking for roles it left open; null where no judge is required |

The engine record lives on `runtimeAssignments`' `decisions` return, not on
the assignment entries the scheduler persists: the snapshot's
`routing.assignments` field set (`validateRoutingState`,
`src/contract/snapshot.mjs`) still carries only `worker`, `judge`,
`composedWorker`, `composedJudge` — the same declared lag as the catalogue
observables below, and it widens the same way, when a reader needs the record
durably.

## The verification mutation tier

The `mutation` field on a task-packet verification command (`VerificationCommand`,
`src/contract/verification.mjs`) is authored in the packet's `verification`
array and never rewritten afterwards: `validateVerificationCommand`
(`src/contract/verification.mjs`) normalizes it once, at contract validation,
and `runMutation` (`src/engine/mutation.mjs`) only reads the declared tier,
resolving the kill fraction from `MUTATION_TIERS` — a reader, not a second
writer. One writer (the packet's authoring), one moment.

## The ratchet, measured

Measured 2026-09-16: **15 entries have more than one writer.** They are a
ratchet, not a target. The test asserts the number is exactly 15 and that every
declared writer set matches the one derived from `src/`, so a *new* second
writer fails immediately, and fixing one of these fails until the count and this
list are lowered together.

**`events.jsonl` (14):** `at`, `contractVersion`, `error`, `errorCode`,
`invocationId`, `override`, `recovery`, `role`, `schemaVersion`, `summary`,
`type`, `unexpectedPathCount`, `unexpectedPaths`, `verdict`.

**`journal.jsonl` (1):** `session.attached` — written both by the explicit
`attach` command and by the once-a-day implicit attach on sync. The two emitters
must keep producing the same nine fields.

`invocationId` joined the list when the phase-2 stale-group signal guard landed:
`recordIdentityUnverifiable` (`src/engine/process.mjs`) appends an
`invocation_identity_unverifiable` line — with the invocation's id, and, newly
declared above, its `pid` and `processGroupId` — whenever a signal is withheld
because the invocation's process identity cannot be proven. The guard needs the
id in the record, so it is now a second writer of a field `appendTransitionEvent`
used to own alone.

Nothing on this list is fixed in this node. Changing who writes a field changes
behavior, and a node that declares must not also move the thing it declares.

## Source of truth

<!-- FIELD-OWNERSHIP-SOURCE -->
```json
{
  "journal": {
    "campaign.initialized": { "writers": ["initializeCampaign"], "fields": ["at", "type", "eventId"] },
    "campaign.closed": { "writers": ["closeCampaign"], "fields": ["at", "type", "eventId"] },
    "campaign.unparked": { "writers": ["unparkCampaign"], "fields": ["at", "type", "eventId", "code", "runId"] },
    "run.registered": { "writers": ["registerRun"], "fields": ["at", "type", "eventId", "runId"] },
    "session.attached": { "writers": ["attach", "attachSessionOnceDaily"], "fields": ["at", "type", "eventId", "sessionId", "tool", "transcript", "transcriptUnavailable", "format", "cursor"] },
    "intent": { "writers": ["note"], "fields": ["at", "type", "eventId", "sessionId", "text"] },
    "decision": { "writers": ["note"], "fields": ["at", "type", "eventId", "sessionId", "decisionId", "text"] },
    "supersede": { "writers": ["note"], "fields": ["at", "type", "eventId", "sessionId", "supersedes", "text"] },
    "constraint": { "writers": ["note"], "fields": ["at", "type", "eventId", "sessionId", "text"] },
    "outcome": { "writers": ["note"], "fields": ["at", "type", "eventId", "sessionId", "text", "runId"] },
    "next": { "writers": ["note"], "fields": ["at", "type", "eventId", "sessionId", "text"] },
    "open-question": { "writers": ["note"], "fields": ["at", "type", "eventId", "sessionId", "questionId", "text"] },
    "question.resolved": { "writers": ["resolveQuestion"], "fields": ["at", "type", "eventId", "sessionId", "questionId", "text"] },
    "operator.command": { "writers": ["recordOperatorCommand"], "fields": ["at", "type", "eventId", "command", "sessionId", "runId"] },
    "retrospective": { "writers": ["note"], "fields": ["at", "type", "eventId", "sessionId", "text"] },
    "seat.allowance": { "writers": ["appendSeatAllowanceEvent"], "fields": ["at", "type", "eventId", "sample", "harness", "remaining", "limit", "resetsAt", "delta", "window"] }
  },
  "events": {
    "schemaVersion": { "writers": ["appendTransitionEvent", "assertEnvironmentReady"] },
    "contractVersion": { "writers": ["appendTransitionEvent", "assertEnvironmentReady"] },
    "at": { "writers": ["appendTransitionEvent", "assertEnvironmentReady", "renderCampaignHandoffSafely", "recordIdentityUnverifiable"] },
    "node": { "writers": ["appendTransitionEvent"] },
    "sourceIdentity": { "writers": ["appendTransitionEvent"] },
    "packetHash": { "writers": ["appendTransitionEvent"] },
    "from": { "writers": ["appendTransitionEvent"] },
    "to": { "writers": ["appendTransitionEvent"] },
    "phase": { "writers": ["appendTransitionEvent"] },
    "attempt": { "writers": ["appendTransitionEvent"] },
    "runtime": { "writers": ["appendTransitionEvent"] },
    "error": { "writers": ["appendTransitionEvent", "renderCampaignHandoffSafely"] },
    "verdict": { "writers": ["appendTransitionEvent", "settleAdvisoryReview"] },
    "summary": { "writers": ["appendTransitionEvent", "settleAdvisoryReview"] },
    "revisions": { "writers": ["appendTransitionEvent"] },
    "requirementIds": { "writers": ["appendTransitionEvent"] },
    "invocationId": { "writers": ["appendTransitionEvent", "recordIdentityUnverifiable"] },
    "pid": { "writers": ["recordIdentityUnverifiable"] },
    "processGroupId": { "writers": ["recordIdentityUnverifiable"] },
    "override": { "writers": ["recordExecutionOverride", "applyRoute"] },
    "recovery": { "writers": ["ensureTerminalEvent", "recordExecutionOverride"] },
    "role": { "writers": ["applyRoute", "autoRetryNode"] },
    "status": { "writers": ["applyRoute"] },
    "currentRuntime": { "writers": ["applyRoute"] },
    "errorCode": { "writers": ["applyRoute", "autoRetryNode"] },
    "unexpectedPaths": { "writers": ["checkWorkerScope", "checkPersistedWorkerScope", "recordScopeFinding"] },
    "unexpectedPathCount": { "writers": ["checkWorkerScope", "checkPersistedWorkerScope", "recordScopeFinding"] },
    "type": { "writers": ["recordScopeFinding", "settleAdvisoryReview", "assertEnvironmentReady", "renderCampaignHandoffSafely", "autoRetryNode", "recordIdentityUnverifiable"] },
    "contractId": { "writers": ["assertEnvironmentReady"] },
    "ok": { "writers": ["assertEnvironmentReady"] },
    "checks": { "writers": ["assertEnvironmentReady"] },
    "campaignId": { "writers": ["renderCampaignHandoffSafely"] }
  },
  "campaign": {
    "requirements": { "writers": ["closeCampaign"] }
  }
}
```
