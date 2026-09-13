# Intent Factory operations

## Attempt worktrees

An execution repository is a git work tree with at least one commit. A run
creates the integration head `refs/intent-factory/<run-id>/run` at the
recorded source `gitHead`. Every worker attempt gets a linked worktree at
`.runs/worktrees/<run-id>/<node-id>.<attempt>` on branch
`if/<run-id>/<node-id>/<attempt>`, cut from that ref. The node snapshot
records `worktree.path`, `.branch`, `.baseSha`, and the sealed `.commit`.
Provider processes, scope snapshots, controller verification, and judges all
use that path; `contract.cwd` stays the home of run/control artifacts. An
installed root `node_modules` is symlinked into every attempt worktree, never
copied.

A retried attempt never discards the previous one's edits: the controller
seals the previous attempt's worktree first, and when that seal has a diff,
the next attempt is cut from that sealed sha (`worktree.previousAttempt`
records which); an empty seal falls back to the run ref tip.

`contract.maxParallel` bounds concurrent nodes; each tick the scheduler
dispatches every `pending` node whose dependencies are `done`, up to the free
slot count, each into its own worktree. Integration stays serialized
regardless of `maxParallel`.

## Integration transaction

The controller serializes integration. It seals any uncommitted attempt
edits with a commit naming the run/node/attempt (`empty: true` in the
journal when there is no diff), appends a `prepared` record to
`integration.jsonl` (node, attempt, attempt sha, previous run-ref tip,
candidate sha, verification evidence) before creating anything, and builds
the candidate — fast-forward or merge — on
`refs/intent-factory/<run-id>/candidate` /
`.runs/worktrees/<run-id>/.candidate`. Node `verification` runs once there. A
pass advances the run ref with a conditional `update-ref` and makes one node
state write to `done` with `integratedHead`. A failed candidate removes the
candidate ref/worktree, leaves the run ref untouched, and keeps the attempt
worktree. A conflict marks the node `attention` with the conflicting paths
and cleans the scratch worktree.

Resume replays `integration.jsonl`, never ancestry, to identify the one
unfinished transaction and complete it idempotently (including an accepted
no-change candidate). A resume that re-dispatches a failed/stalled/
exhausted/canceled node cuts the next attempt from the previous attempt's
sealed sha, the same continuation rule as any other retry.

## Controller lock and takeover

One controller drives a run, holding `<run-dir>/controller.lock`: `{pid,
processStartToken, startedAt, hostname}`. Acquisition is an exclusive
create; there is no TTL. A contender treats the lock as stale only once it
can prove the holder dead — the pid is gone, or its process start token no
longer matches (pid recycled); anything short of that is `controller_active`
and the contender exits untouched. Takeover renames the lock aside, re-checks
the captured record is still stale, then installs its own; a capture that
turns out live is handed back under its original name.
Worker/judge/verification children run detached in their own process group,
so before dispatching anything new, `resume`'s recovery pass terminates
(`SIGTERM` then `SIGKILL`, same as `cancel`) every invocation recorded for a
`running` node — unless it is still inside its deadline, in which case it is
adopted and its result read. `cancel <run-dir>`
signals a live controller to death first, so its own takeover never waits on
an expiry.

`supervise <run-dir> [--detach] [--interval <sec>]` is the watchdog above that.
It holds no lock and writes no state: every interval (default 30s) it launches
`resume --detach` when a node is unfinished and no controller is live, exits 0
once all are terminal, and stops after three failed launches. An empty run
directory is never resumed — it has not proved it needs to be.

## Runtime discovery

`doctor --discover [--json]` performs mutation-free harness discovery,
reporting `{available, exhaustedUntil, reason}` per runtime (missing CLI →
`not_found`; auth failure has no reset; quota keeps its reset, including Z.ai
code 1310). Omitted `runtimes`/`runtimeDefaults` are composed once and persisted
in `routing.assignments`; exhaustion re-tiers within the current tier only,
otherwise the node parks `attention` with `runtime_tier_exhausted`. Failover
and vendor rules: [contract.md](contract.md).

## Status

`<run-dir>/status.json` (`status --json`'s payload: `schemaVersion`, run
identifiers, `goal`, `usage`, `controller` state, `summary`, and one
`nodes[]` entry per node — id, status, phase, runtime, attempt, revisions,
cost, verdict, note, `errorCode`, `blockedBy`) and `.runs/status.json`
(a ≤1 KiB pointer: run and campaign id, `state`, checkpoints, `activeNode`,
`costUsd`, `needsYou`, `attention`, `generatedAt` unix seconds) are written atomically every controller tick and at run
terminal. `status <run-dir>` renders, in order: Needs you (attention nodes
and orphans), Now (active node, elapsed, cost, or idle), Nodes (one row per
node), Cost (run totals). `integrations/claude-code/statusline.sh` reads the
pointer for an ambient prompt segment. `next [--cwd <dir>] [--json]` prints one line per active campaign naming the most urgent action and its command; read-only, no lock, writes nothing.

## Dashboard

`node src/web/server.mjs [--port 4173] [--cwd <repo>]` serves a read-only,
SSE-refreshed page on `127.0.0.1:4173` over `status.json`, node JSON,
`events.jsonl`, `usage.jsonl`, `notify.jsonl` and `HANDOFF.md` only. Sections:
campaign picker; **Now**; **Needs you** (one line per attention item with the
resolving command); **Runs**; **Run drawer** on row click with per-node tabs
(log tail, verification, diff, findings, prompt); **Handoff**. The snapshot is
bounded to 200 KiB, shrinking the open drawer's tails, then its prompt, then
the handoff.

## Remote API

The same server exposes the operator's phone surface under `/api/*`, behind
the same token and bind. Reads: `GET /api/campaigns`,
`/api/campaigns/<id>` (campaign and run rows), `…/brief` (the
`operator-brief.md` the seat materializes), `/api/seats` (the seat
registry), and `…/events?after=<cursor>` — one bounded page (≤32 KiB,
≤100 entries) of the journal from the returned byte cursor; a
client starting at zero never drags the whole journal. Every
write shells out to the runner CLI and touches no state itself:
`POST …/decisions/<id>` → `campaign resolve`; `…/note` → `campaign note`;
`…/pause` and `…/resume` → `cancel` / `resume --detach` once per linked run
with work in flight; `/api/seats/<id>/switch` → `seat switch`. No replan,
contract, routing or gate route exists on purpose: the contract is frozen
with a digest, and the phone's middle ground is a note.

## Notify

On `node.terminal`, `run.terminal` and `attention` the controller renders a
one-line message from counters and identifiers only (node id, run id, state,
attempt, error code, done/total — never model text), calls the executable named
by `INTENT_FACTORY_NOTIFY_BIN` with that event as JSON on stdin, and appends a
timestamped receipt (`delivered`, `failed`, `no_transport`) to
`<run-dir>/notify.jsonl`. Exit 0 is the only success; anything else retries on a
later tick, three attempts with backoff (`INTENT_FACTORY_NOTIFY_BACKOFF_MS`).
Unset, nothing is spawned and the receipt is `no_transport`. `INTENT_FACTORY_NOTIFY_BIN=os-macos` selects the bundled
`osascript` adapter; any other value is an executable path. A resume never
re-sends a notification already recorded in `notify.jsonl` for the same
node, attempt, and outcome.

## Campaigns

Every contract requires `campaignId`; campaign state lives at
`.runs/campaigns/<campaign-id>/` (`campaign.json`, `journal.jsonl`,
`HANDOFF.md`) and can link multiple runs.

```bash
node src/cli.mjs campaign <op> <id> [--cwd <dir>] …flags
  init --goal "Goal" | attach --tool codex --session-id <s> --transcript <path> --format jsonl
  note --session-id <s> --kind <intent|decision|supersede|constraint|outcome|next|open-question|retrospective> --text <t>
  resolve --session-id <s> --question-id <q> --text <a> | sync --session-id <s> | ack --session-id <s> --event-id <e>
  watch --wake | show | close  ·  list (no id)
```

`sync` is the user-pull read: campaign header, the newest linked run's
`status.json` summary, and unseen journal events (≤8000 bytes) after the
session's durable cursor, without moving it. `ack` is the only cursor
writer, keyed by the journal's own event id. `watch --wake` polls every
linked run's `status.json` every 30s and prints one line per actionable
change (a run gone terminal, a node in attention, a stale controller lock,
or twenty idle minutes), exiting once the campaign is closed. `close` refuses until a `retrospective` note exists; a closed campaign stays
inspectable but rejects further writes. It also mirrors its active state into a managed `<!-- intent-factory-active:start -->` block at the bottom of the target repo's `AGENTS.md`, so an unrelated session sees active work.

`HANDOFF.md` is an atomic, ≤16 KiB projection of recent intents, decisions,
constraints, outcomes, next action and open questions, refreshed at
initialization, registration, state transitions and terminal completion;
`journal.jsonl` is the append-only, fsynced full narrative.

## Operator seat

The seat is one tmux session, `intent-factory-seat`, with one window per open
campaign. It hosts the operator's interactive harness and never drives a run:
state writes stay with the controller, and a dead pane cannot touch `.runs/`.
The harness registry (`src/seat/harnesses.mjs`) declares five entries
— `claude`, `codex`, `zcode`, `dsh`, `agy` — each with interactive argv, an
environment marker, and `canRenderAmbient` (claude only).

```bash
node src/cli.mjs seat start <campaign-id> --cwd <dir> [--harness <name>]
node src/cli.mjs seat attach [<campaign-id>] [--cwd <dir>] [--ssh <host>]
node src/cli.mjs seat status [--json] [--cwd <dir>]
node src/cli.mjs seat stop [<campaign-id>] [--cwd <dir>]
```

`attach` prints the command to paste rather than running `tmux attach`, which
would nest sessions; `--ssh <host>` prints the remote `ssh -t` line. `status
--json` lists each window's campaign, harness and ambient capability. tmux is
optional: every `seat` function returns an explicit unavailable result when the
binary is absent, and only reattaching is lost.
