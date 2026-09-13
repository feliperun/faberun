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
  diagnostics appended directly by `src/engine/run-identity.mjs` and
  `src/engine/notify-queue.mjs`.
- **`journal.jsonl`** — a campaign's material events, appended through
  `appendJournal` in `src/campaign/journal.mjs` by the emitters that build each
  event type.

The machine-readable block at the end of this file is the source of truth for
both records. `test/campaign/field-ownership.test.mjs` — the test named `single
writer per field` — re-derives every writer from `src/` and fails when the
derivation disagrees with this document. The document is the declaration; the
test is what keeps it from becoming fiction on the third change.

**Measured 2026-09-12 against this tree:** 29 `events.jsonl` fields and 13
`journal.jsonl` event types. Twelve entries have more than one writer today.
Those twelve are the ratchet at the end of this file; they are declared, not
fixed, because changing who writes a field is a behavior change and belongs to
another node.

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
| `at` | `appendTransitionEvent`, `assertEnvironmentReady`, `renderCampaignHandoffSafely` **(ratchet)** | at append, from `state.updatedAt` (set by `transition`); the two diagnostics take `new Date().toISOString()` |
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
| `invocationId` | `appendTransitionEvent` | at append, the last invocation's id when set |
| `override` | `recordExecutionOverride`, `applyRoute` **(ratchet)** | when an execution override is recorded; when a route is applied |
| `recovery` | `ensureTerminalEvent`, `recordExecutionOverride` **(ratchet)** | when a terminal side effect is replayed; when an override carries a recovery note |
| `role` | `applyRoute` | when a route is applied |
| `status` | `applyRoute` | when a route is applied |
| `currentRuntime` | `applyRoute` | when a route is applied |
| `errorCode` | `applyRoute` | when a route is applied |
| `unexpectedPaths` | `checkWorkerScope`, `checkPersistedWorkerScope`, `recordScopeFinding` **(ratchet)** | when a scope check fails or an advisory finding is recorded |
| `unexpectedPathCount` | `checkWorkerScope`, `checkPersistedWorkerScope`, `recordScopeFinding` **(ratchet)** | when a scope check fails or an advisory finding is recorded |
| `type` | `recordScopeFinding`, `settleAdvisoryReview`, `assertEnvironmentReady`, `renderCampaignHandoffSafely` **(ratchet)** | each diagnostic sets its own discriminator; there is no single owner today |
| `contractId` | `assertEnvironmentReady` | when the environment preflight fails |
| `ok` | `assertEnvironmentReady` | when the environment preflight fails |
| `checks` | `assertEnvironmentReady` | when the environment preflight fails |
| `campaignId` | `renderCampaignHandoffSafely` | when rendering the campaign handoff fails |

## `journal.jsonl`

The writer of each event is the emitter that builds it: `initializeCampaign`,
`closeCampaign` and `registerRun` in `src/campaign/index.mjs`; `attach`, `note`,
`resolveQuestion` and `attachSessionOnceDaily` in `src/cli/campaign.mjs`. The
field set of each type is the one `ENTRY_SHAPES` accepts in
`src/campaign/journal.mjs`; it is listed here so the document and the schema
cannot drift apart.

| event type | writer(s) | fields | written when |
| --- | --- | --- | --- |
| `campaign.initialized` | `initializeCampaign` | `at`, `type`, `eventId` | when the campaign directory is created |
| `campaign.closed` | `closeCampaign` | `at`, `type`, `eventId` | when a campaign with a retrospective is closed |
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
| `retrospective` | `note` | `at`, `type`, `eventId`, `sessionId`, `text` | when a note of that kind is recorded |

## The ratchet, measured

Measured 2026-09-12: **12 entries have more than one writer.** They are a
ratchet, not a target. The test asserts the number is exactly 12 and that every
declared writer set matches the one derived from `src/`, so a *new* second
writer fails immediately, and fixing one of these fails until the count and this
list are lowered together.

**`events.jsonl` (11):** `at`, `contractVersion`, `error`, `override`,
`recovery`, `schemaVersion`, `summary`, `type`, `unexpectedPathCount`,
`unexpectedPaths`, `verdict`.

**`journal.jsonl` (1):** `session.attached` — written both by the explicit
`attach` command and by the once-a-day implicit attach on sync. The two emitters
must keep producing the same nine fields.

Nothing on this list is fixed in this node. Changing who writes a field changes
behavior, and a node that declares must not also move the thing it declares.

## Source of truth

<!-- FIELD-OWNERSHIP-SOURCE -->
```json
{
  "journal": {
    "campaign.initialized": { "writers": ["initializeCampaign"], "fields": ["at", "type", "eventId"] },
    "campaign.closed": { "writers": ["closeCampaign"], "fields": ["at", "type", "eventId"] },
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
    "retrospective": { "writers": ["note"], "fields": ["at", "type", "eventId", "sessionId", "text"] }
  },
  "events": {
    "schemaVersion": { "writers": ["appendTransitionEvent", "assertEnvironmentReady"] },
    "contractVersion": { "writers": ["appendTransitionEvent", "assertEnvironmentReady"] },
    "at": { "writers": ["appendTransitionEvent", "assertEnvironmentReady", "renderCampaignHandoffSafely"] },
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
    "invocationId": { "writers": ["appendTransitionEvent"] },
    "override": { "writers": ["recordExecutionOverride", "applyRoute"] },
    "recovery": { "writers": ["ensureTerminalEvent", "recordExecutionOverride"] },
    "role": { "writers": ["applyRoute"] },
    "status": { "writers": ["applyRoute"] },
    "currentRuntime": { "writers": ["applyRoute"] },
    "errorCode": { "writers": ["applyRoute"] },
    "unexpectedPaths": { "writers": ["checkWorkerScope", "checkPersistedWorkerScope", "recordScopeFinding"] },
    "unexpectedPathCount": { "writers": ["checkWorkerScope", "checkPersistedWorkerScope", "recordScopeFinding"] },
    "type": { "writers": ["recordScopeFinding", "settleAdvisoryReview", "assertEnvironmentReady", "renderCampaignHandoffSafely"] },
    "contractId": { "writers": ["assertEnvironmentReady"] },
    "ok": { "writers": ["assertEnvironmentReady"] },
    "checks": { "writers": ["assertEnvironmentReady"] },
    "campaignId": { "writers": ["renderCampaignHandoffSafely"] }
  }
}
```
