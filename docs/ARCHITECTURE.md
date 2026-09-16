# Architecture

> Current-state summary. [ADRs](adr/README.md) hold the history and the *why*;
> this file reflects only **active** decisions. Dated records live in
> [docs/history/](history/README.md).

## High-level flow

Faberun turns an intent into verified software by owning the process around the
model calls. The operator writes an intent into a *campaign* and an authored
*contract* into a target repository. The contract is plain JSON: a
schema-versioned DAG of *nodes*, each node a closed *task packet* with a
definition of done. `validate` parses it; `preflight` checks the host, the
runtime binaries and their credentials.

A *controller* process owns the run. It holds the run's lock, schedules every
dependency-ready node, and dispatches each *attempt* into its own git worktree
cut from the run's integration ref. A *worker* — one harness running one model,
given the packet's read and write scope — produces the change. The controller
then runs the contract's deterministic verification commands once, and a
cross-vendor *judge* reviews the recorded result without re-running it. A
passing attempt is sealed and integrated onto the run ref; a campaign promotes
each run onto its landing branch, and the orchestrator lands that branch on
`main`.

```text
intent
  └─ contract ── validate · preflight
        └─ controller (one detached process, holds the run lock)
              ├─ dispatch node ──► worker in an attempt worktree
              │                       ├─ deterministic verification
              │                       └─ cross-vendor judge
              └─ integrate ──► run ref ──► landing branch ──► main
```

## Layers

`src/` is the source; each directory is a layer, and the layer names are the
vocabulary. `bin/faberun.mjs` is the entry point and calls into `src/`. `test/`
mirrors `src/` by directory; `evals/` holds deterministic fixtures;
`skills/` holds the shipped skills; `integrations/` holds editor and shell
integrations; `docs/` holds the user-facing documentation.

| directory | owns |
| --- | --- |
| `src/cli.mjs`, `src/cli/` | argv, dispatch, usage. No domain logic. |
| `src/contract/` | the authored artefact: schema and validation. Reads only files the contract itself names (`taskPacketFile`); spawns nothing. |
| `src/engine/` | the control loop: scheduler, node lifecycle, routing, gates. |
| `src/harnesses/` | one adapter per provider harness, plus what each one can run. |
| `src/campaign/` | the durable layer above runs. |
| `src/repo/` | anything that touches the target repository: git, worktrees, the workspace. |
| `src/run/` | the `.runs/` directory: store, lock, ledgers, gc. |
| `src/report/`, `src/web/` | the two ways a human reads a run. Presentation only. |
| `src/host/` | facts about the machine. |
| `src/notify/` | notification transports. |
| `src/util.mjs` | helpers with no domain. Nothing imports a layer from here. |

## `.runs/` layout

Everything the controller writes lives under the target repository's gitignored
`.runs/`:

```text
.runs/
  <run-id>/
    contract.json run.json status.json findings.json STATUS.md
    nodes/<node-id>.json
    logs/<node-id>.<attempt>.<worker|judge>[.r<n>].jsonl / .err
    operations/<invocationId>.intent.json / .settlement.json
    usage.jsonl integration.jsonl events.jsonl notify.jsonl
  worktrees/<run-id>/<node-id>.<attempt>/
  control/<campaign-id>/controller/
  campaigns/<campaign-id>/
    campaign.json journal.jsonl HANDOFF.md projection.json
  status.json
  inbox.jsonl
```

- **`<run-id>/`** is one run's durable record. `contract.json` inlines every
  packet and carries the `packetHash` the runner validates on load, so the
  directory is a self-contained, resumable record. `nodes/<id>.json` is the
  node snapshot; `status.json` is the payload `status --json` prints;
  `STATUS.md` is the human summary; `findings.json` holds gate findings and
  blocking questions.
- **`logs/`** holds the raw worker and judge streams; **`operations/`** holds
  the exact-once intent and settlement record for every provider invocation.
- **`usage.jsonl`** is one line per invocation — tokens and cost for reporting
  only; no control path reads it. **`integration.jsonl`** is the serialized
  integration transaction log. **`events.jsonl`** is the append-only node
  transition record. **`notify.jsonl`** holds delivery receipts.
- **`worktrees/`** holds every attempt worktree and the integration candidate
  (`.candidate`). An installed root `node_modules` is symlinked into each one,
  never copied.
- **`control/<campaign-id>/controller/`** is the immutable `git archive`
  snapshot the controller runs from, so workers editing `src/` cannot change
  the code driving them.
- **`campaigns/<campaign-id>/`** holds `campaign.json` (manifest),
  `journal.jsonl` (append-only, fsynced narrative), `HANDOFF.md` (a bounded
  projection) and `projection.json`.
- **`.runs/status.json`** is the ≤1 KiB pointer an ambient statusline reads;
  **`.runs/inbox.jsonl`** is the append-only campaign notification queue.

The workspace snapshot skips `.runs`, `.git`, `node_modules`, `.claude` and
`.codex` at the repository root.

## Process model

**Controller lock.** One controller drives a run, holding
`<run-dir>/controller.lock` (`{pid, processStartToken, startedAt, hostname}`).
Acquisition is an exclusive create with no TTL. A contender treats the lock as
stale only once it can prove the holder dead — the pid is gone, or its process
start token no longer matches. Takeover renames the lock aside, re-checks the
captured record is stale, and installs its own; a capture that turns out live
is handed back. `cancel` signals a live controller first, so its own takeover
never waits on an expiry.

**Detached children.** Worker, judge and verification children run detached in
their own process groups. Before dispatching new work, `resume`'s recovery pass
terminates every invocation recorded for a `running` node — unless it is still
inside its deadline, when it is adopted and its result read.

**Heartbeat.** The controller writes `<run-dir>/status.json` and the
`.runs/status.json` pointer atomically every tick and at run terminal.
`integrations/claude-code/statusline.sh` reads the pointer; the target
`AGENTS.md` managed block mirrors active state and names the command that
resolves each parked node.

**`supervise`.** `supervise <run-dir> [--detach] [--interval <sec>]` is the
watchdog above the controller. It holds no lock and writes no state: every
interval (default 30s) it launches `resume --detach` when a node is unfinished
and no controller is live, exits 0 once all are terminal, and stops after three
failed launches. It never resumes an empty run directory. `supervise campaign
<campaign-id>` drives the campaign chain instead.

**`resume`.** `resume <run-dir>` continues an interrupted run in place: same
run, same node, attempt plus one, packet frozen. It replays `integration.jsonl`
— never git ancestry — to identify the one unfinished integration transaction
and complete it idempotently. It adopts completed work first (a finished worker
turn recovered from its log, a `judge_unavailable` node re-judged from the
preserved result), and only then re-dispatches ordinary failures. `--node`
limits the retry, `--answer` supplies a missing read, and `--reconcile` handles
an unknown-effect window.

**Campaign chain and coordinator.** Campaign state lives at
`.runs/campaigns/<id>/`. The manifest registers one contract per phase;
`supervise campaign` promotes each finished run onto the campaign's landing
branch; the orchestrator lands that branch on `main` and closes the campaign
after a `retrospective` note. A campaign refuses to close without one.

## Quality gates

- **Source shape** (`test/repo/source-shape.test.mjs`): no file over 800 lines,
  no runtime import cycle in `src/`, no top-level body defined twice, no name
  exported from two `src/` modules (`harness` is exempt: every adapter exports
  it, and that uniformity is the registry interface), no barrel modules, no
  empty `catch {}`, and a ratchet on modules whose header comment is missing.
  No test may bound a measured duration from above. `noUnusedLocals` makes
  `npm run typecheck` the gate for unused declarations.
- **Types** (`npm run typecheck`): `tsc` over the whole tree in `checkJs` mode,
  `noEmit`, and must be clean.
- **Deterministic and discriminating evals** (`evals/run.mjs`):
  `--class deterministic --assert-no-model` runs every case with zero model
  calls, `replay` standing in for the providers; `--verify-discriminating`
  requires each case's declared mutation to make the case fail, so a case that
  proves nothing is reported. `evals/golden/` fixtures are historical record.
- **Docs ratchets:** `test/docs/docs-diet.test.mjs` bounds the skill router and
  references by bytes; `test/docs/command-surface.test.mjs` compares
  `docs/COMMANDS.md` with the CLI in both directions;
  `test/docs/link-check.test.mjs` resolves every relative link;
  `test/repo/brand.test.mjs` keeps the live tree free of the old name; and
  `test/campaign/field-ownership.test.mjs` keeps `docs/FIELD-OWNERSHIP.md` true
  against `src/`. `npm test` runs them together.

## Security model

- **Closed packets are detectors, not sandboxes.** A packet's
  `readFiles`/`writeFiles` (or an `autonomous` packet's `writeRoots`) declare
  scope. A completed attempt whose worker result and verification both pass
  keeps unexpected writes as a `scopeFindings` entry and still reaches `done`;
  only a failed verification turns the unexpected paths into part of the
  failure. A directory-shaped `writeRoots` entry authorizes descendants; a
  file-shaped one authorizes only that exact path.
- **Credentials travel as variable names, never values.**
  `config["api_key.env_key"]` and `config["auth_token.env_key"]` name the
  environment variable for preflight; `verification[].env` declares names only.
  Values stay in the shell and in the harness's own session.
- **`bypassPermissions` only in a recoverable repository.** Headless
  `acceptEdits` denies execution, so a node that runs commands needs
  `bypassPermissions` (claude) or `yolo` (zcode); `dsh` defaults to
  `workspace-write` and uses `danger-full-access` only for effects outside the
  worktree. The target is a git work tree, so every attempt is recoverable from
  its worktree and the run ref.
- **Snapshot and install.** The workspace snapshot skips `.runs`, `.git`,
  `node_modules`, `.claude` and `.codex` at the repository root; `.runs/` is
  git-ignored. An installed root `node_modules` is symlinked into every attempt
  worktree, never copied. The shell scripts are idempotent: a re-run completes
  what is missing instead of duplicating or destroying.
- **No secrets committed.** The `pre-commit` hook scans the staged diff;
  tokens and service accounts stay in a secret manager or a gitignored `.env`.

## Related docs

- [VISION.md](VISION.md) · [CONCEPTS.md](CONCEPTS.md) · [COMMANDS.md](COMMANDS.md)
- [GETTING-STARTED.md](GETTING-STARTED.md) · [ADRs](adr/README.md)
- [FIELD-OWNERSHIP.md](FIELD-OWNERSHIP.md) · [history/README.md](history/README.md)
- [harnesses/zcode-cli.md](harnesses/zcode-cli.md) · [AGENTS.md](../AGENTS.md)
- [contract reference](../skills/faberun/references/contract.md) ·
  [operations reference](../skills/faberun/references/operations.md)
