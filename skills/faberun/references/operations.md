# Faberun operations

## Attempt worktrees

An execution repository is a git work tree with at least one commit. A run
creates the integration head `refs/faberun/<run-id>/run` at the recorded
source `gitHead`. Every worker attempt gets a linked worktree at
`.runs/worktrees/<run-id>/<node-id>.<attempt>` on branch
`faberun/<run-id>/<node-id>/<attempt>`, cut from that ref; the node snapshot records
`worktree.path`, `.branch`, `.baseSha` and the sealed `.commit`. Provider,
scope, verification and judge processes all use that path; `contract.cwd` stays
the home of run/control artifacts. An installed root `node_modules` is
symlinked into every attempt worktree, never copied.

A retried attempt never discards the previous one's edits: the controller seals
the previous worktree first and, when that seal has a diff, cuts the next
attempt from that sha (`worktree.previousAttempt`); an empty seal falls back to
the run ref tip.

`contract.maxParallel` bounds concurrent nodes; each tick dispatches every
`pending` node whose dependencies are `done`, up to the free slots, each into
its own worktree. Integration stays serialized.

## Integration transaction

The controller serializes integration. It seals uncommitted attempt edits with a
commit naming the run/node/attempt (`empty: true` in the journal when there is
no diff), appends a `prepared` record to `integration.jsonl` (node, attempt,
attempt sha, previous run-ref tip, candidate sha, verification evidence) before
creating anything, and builds the candidate — fast-forward or merge — on
`refs/faberun/<run-id>/candidate` / `.runs/worktrees/<run-id>/.candidate`,
where node `verification` runs once. A pass advances the run ref with a
conditional `update-ref` and writes the node `done` with `integratedHead`. A
failed candidate removes the candidate ref/worktree, leaves the run ref
untouched, and keeps the attempt worktree. A conflict marks the node `attention`
with the conflicting paths and cleans the scratch worktree.

Resume replays `integration.jsonl`, never ancestry, to identify the one
unfinished transaction and complete it idempotently. A resume that re-dispatches
a failed/stalled/exhausted/canceled node cuts the next attempt from the previous
attempt's sealed sha, the same continuation rule as any other retry.

## Controller lock and takeover

One controller drives a run, holding `<run-dir>/controller.lock`: `{pid,
processStartToken, startedAt, hostname}`. Acquisition is an exclusive create
with no TTL. A contender treats the lock as stale only once it can prove the
holder dead — the pid is gone, or its process start token no longer matches
(pid recycled); anything less is `controller_active` and it exits untouched.
Takeover renames the lock aside, re-checks the captured record is stale, then
installs its own; a capture that turns out live is handed back. Worker/judge/
verification children run detached in their own process group, so before
dispatching new work `resume`'s recovery pass terminates (`SIGTERM` then
`SIGKILL`, same as `cancel`) every invocation recorded for a `running` node —
unless it is still inside its deadline, when it is adopted and its result read.
`cancel <run-dir>` signals a live controller first, so its own takeover never
waits on an expiry.

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
rules: [contract.md](contract.md).

## Status

`<run-dir>/status.json` (`status --json`'s payload: identifiers, `goal`, `usage`,
`controller` state, `summary`, and one `nodes[]` entry per node — id, status,
phase, runtime, attempt, revisions, cost, verdict, note, `errorCode`,
`blockedBy`) and `.runs/status.json` (a ≤1 KiB pointer: run and campaign id,
`state`, checkpoints, `activeNode`, `costUsd`, `needsYou`, `attention`,
`generatedAt`) are written atomically every controller tick and at run terminal.
`status <run-dir>` renders Needs you, Now, Nodes and Cost;
`integrations/claude-code/statusline.sh` reads the pointer for an ambient prompt
segment. `next [--cwd <dir>] [--json]` prints one line per active campaign
naming the most urgent action and its command; read-only, no lock, writes
nothing.

## Dashboard

`node src/web/server.mjs [--port 4173] [--cwd <repo>]` serves a read-only,
SSE-refreshed page on `127.0.0.1:4173` over `status.json`, node JSON,
`events.jsonl`, `usage.jsonl`, `notify.jsonl` and `HANDOFF.md`. Sections:
campaign picker; **Now**; **Needs you** (each attention item with its resolving
command); **Runs**; **Run drawer** on row click with per-node log, verification,
diff, findings and prompt tabs; **Handoff**. The snapshot is bounded to 200 KiB,
shrinking the drawer's tails, prompt, then handoff.

## Remote API

The same server exposes the phone surface under `/api/*`, behind the
same token and bind. Reads: `GET /api/campaigns`, `/api/campaigns/<id>`,
`…/brief`, `/api/seats`, and `…/events?after=<cursor>` (one bounded page, ≤32 KiB
and ≤100 entries, so a client starting at zero never drags the whole journal).
Writes shell out to the runner CLI and touch no state themselves:
`POST …/decisions/<id>` → `campaign resolve`; `…/note` → `campaign note`;
`…/pause` and `…/resume` → `cancel` / `resume --detach`; `/api/seats/<id>/switch`
→ `seat switch`. No replan, contract, routing or gate route exists on purpose:
the contract is frozen with a digest, and the phone's middle ground is a note.

## Notify

On `node.terminal`, `run.terminal` and `attention` the controller renders a
one-line message from counters and identifiers only (node id, run id, state,
attempt, error code, done/total — never model text), calls the executable named
by `FABERUN_NOTIFY_BIN` with that event as JSON on stdin, and appends a
timestamped receipt (`delivered`, `failed`, `no_transport`) to
`<run-dir>/notify.jsonl`. Delivery is lossy: **exactly one attempt**, no retry,
no backoff; `FABERUN_NOTIFY_BACKOFF_MS` appears nowhere in `src`. Unset,
nothing is spawned and the receipt is `no_transport`.
`FABERUN_NOTIFY_BIN=os-macos` selects the bundled `osascript` adapter
(`canWake: false`); any other value is an executable path. A resume never
re-sends a notification already recorded for the same node, attempt and outcome.
No transport is a default: `doctor`, `preflight` and the foreground launch warn
when the variable is empty, and `--wake` reports no adapter can wake a session.
Campaign-level lines are queued in `.runs/inbox.jsonl`, the managed block's
append-only record — one object per line `{schemaVersion, eventId, at, type,
campaignId, runId, nodeId, status, errorCode, dedupeKey, summary}`, deduped on
`dedupeKey` (first write wins) with one `O_APPEND` write per line.
`campaign watch --wake --detach` queues there and delivers through
`<campaign-dir>/notify.jsonl`; a durable `watch.lock` plus the inbox dedupe keep
two detached watchers from double-sending across a restart.

## Campaigns

Every contract requires `campaignId`; campaign state lives at
`.runs/campaigns/<campaign-id>/` (`campaign.json`, `journal.jsonl`,
`HANDOFF.md`) and can link multiple runs.

```bash
node src/cli.mjs campaign <op> <id> [--cwd <dir>] …flags
  init --goal "Goal" | attach --tool codex --session-id <s> --transcript <path> --format jsonl
  note --session-id <s> --kind <intent|decision|supersede|constraint|outcome|next|open-question|retrospective> --text <t>
  resolve --session-id <s> --question-id <q> --text <a> | sync --session-id <s> | ack --session-id <s> --event-id <e>
  watch --wake [--detach] | show | close  ·  list (no id)
```

`sync` is the user-pull read: campaign header, the newest linked run's
`status.json` summary, and unseen journal events (≤8000 bytes) after the
session cursor, without moving it. `ack` is the only cursor writer, keyed by the
journal's own event id. `watch --wake [--detach]` polls every linked run's
`status.json` every 30s and prints one line per actionable change (terminal run,
attention node, stale controller lock, twenty idle minutes), exiting once the
campaign is closed. `close` refuses until a `retrospective` note exists; a
closed campaign stays inspectable but rejects further writes. The managed block
at the bottom of the target repo's `AGENTS.md` mirrors active state and names a
parked run's nodes, error codes and `resume` command.

`HANDOFF.md` is an atomic ≤16 KiB projection of recent intents, decisions,
constraints, outcomes, next action and open questions, refreshed at
initialization, registration, transitions and terminal completion;
`journal.jsonl` is the append-only, fsynced narrative.

## Operator seat

The seat is one tmux session, `faberun-seat`, with one window per open
campaign. It hosts the operator's interactive harness and never drives a run:
state writes stay with the controller, and a dead pane cannot touch `.runs/`.
The harness registry (`src/seat/harnesses.mjs`) declares five entries — `claude`,
`codex`, `zcode`, `dsh`, `agy` — each with interactive argv, an environment
marker, and `canRenderAmbient` (claude only).

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
