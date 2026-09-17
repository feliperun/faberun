# Faberun concepts

The vocabulary of Faberun and the loop it runs: the core objects, where each
one lives, and the invariant that always holds for it. Read this before adding
a module or authoring a contract; reuse a term before inventing a new one.

Each section is one term. The definition, the location (a file, a directory or
the command that manages it) and the invariant are taken from the skill
references and from `src/`, not from memory.

## Intent

The outcome the operator wants, stated once and kept durable while the tools
that execute it change. An intent is recorded at campaign initialization
(`campaign init --goal`), refined through journal notes of kind `intent`, and
carried into each run as the contract `goal`; it is projected into `HANDOFF.md`.
The invariant: the intent is recorded in the durable campaign layer before a
run launches, and no execution step rewrites it; a changed intent is a new
decision or a `supersede` note, never an edit to the record. See
[COMMANDS.md](COMMANDS.md#campaign) and
[operations.md](../skills/faberun/references/operations.md).

## Campaign

The durable layer above runs: a goal, an ordered manifest of contracts, a
landing branch, and the journal of what happened. Campaign state lives at
`.runs/campaigns/<campaign-id>/` in `campaign.json`, `journal.jsonl` and
`HANDOFF.md`, managed by `campaign init`, `attach`, `note`, `sync`, `ack`,
`watch`, `resolve`, `close`, `list` and `show`. The invariant: every contract
requires a `campaignId`; a campaign can link many runs, and `close` refuses
until a `retrospective` note exists. `close` also copies the journal, the
record and every linked run's usage into `docs/campaigns/<id>/ledger/`, so
that history survives once `.runs/` (gitignored) is pruned. See
[COMMANDS.md](COMMANDS.md#campaign) and
[operations.md](../skills/faberun/references/operations.md).

## Contract

The authored artefact that fixes one approved plan step: schema and protocol
versions, goal, working directory, runtimes, and the node DAG with its gates and
definitions of done. It is written as `contract.json`, checked by `validate` and
`preflight`, and stored in the run directory with every task packet inlined and
a `packetHash`. The invariant: a contract is authored once, checked for a
digest, and frozen; the stored copy is self-contained, and the runner validates
the packet hash on load so an interrupted run resumes against the same graph.
See [contract.md](../skills/faberun/references/contract.md) and
[COMMANDS.md](COMMANDS.md#validate).

## Run

The execution of one contract in place: a self-contained directory under
`<cwd>/.runs/<id>/` with the contract, node snapshots, logs, usage,
integration ledger and `STATUS.md`. A run is started by `run --detach`, watched
by `supervise`, and continued in place by `resume`. The invariant: one
controller drives a run at a time, holding `<run-dir>/controller.lock`; an
existing run directory is never overwritten, and a non-terminal run is never
re-authored when it can be resumed. See
[operations.md](../skills/faberun/references/operations.md) and
[workflow.md](../skills/faberun/references/workflow.md).

## Node

One unit of work in the contract DAG: a task packet, a set of dependencies, an
optional gate, and a definition of done. Nodes live in `contract.nodes[]` and
their per-attempt state in `<run-dir>/nodes/<id>.json`. The invariant:
`dependsOn` forms a DAG; a node starts only once every dependency is `done`, a
failed terminal dependency makes it `blocked`, and every node ends in exactly
one terminal state: `done`, `no-op`, `blocked`, `failed`, `exhausted`,
`stalled` or `canceled`. See
[contract.md](../skills/faberun/references/contract.md).

## Task packet and its three modes

The closed instruction a node gives its worker: an objective, instructions,
exact `readFiles` and `writeFiles`, `symbols`, decisions, non-goals and
verification commands. `mode` is `execution`, `discovery` or `autonomous`. An
execution packet requires non-empty `readFiles` and `writeFiles`; a discovery
packet has empty `writeFiles` and may read the repository read-only only when
its `readFiles` is also empty, the one exception to closed scope; an autonomous
packet declares `writeRoots` for bounded whole-repo work. Packets are authored
as `taskPacketFile` and inlined into the stored `contract.json`. The invariant:
an execution or autonomous packet is closed to the files and roots it lists,
read paths are relative to `cwd`, cannot escape it and must exist at validation,
and scope is advisory after an attempt that passes rather than a sandbox. The
node's declared reference load -- the summed byte size of its `readFiles` in
the attempt worktree at dispatch -- is recorded on the node snapshot as
`declaredReadBytes` and surfaced in `status --json` and `report --json`, since
the worker reads the files itself and this is the one quantity the controller
can measure about it. See
[contract.md](../skills/faberun/references/contract.md) and
[handoffs.md](../skills/faberun/references/handoffs.md).

## Worker

The runtime that executes one node's task packet and returns a structured worker
result. A worker runtime is resolved from `nodes[].runtime`, then
`runtimeDefaults.worker`, and runs inside the node's attempt worktree. The
invariant: a worker inspects only the paths its packet lists and returns `done`
or the structured `blocked_context` result rather than exploring; its result is
bounded and canonical, and unknown provider fields are dropped. See
[contract.md](../skills/faberun/references/contract.md) and
[handoffs.md](../skills/faberun/references/handoffs.md).

## Judge

The runtime that reviews a node's captured results after deterministic
verification has run. A judge runtime is resolved from `nodes[].gate.runtime`,
then `runtimeDefaults.judge`; an output is `pass` only with empty `findings` and
`maxSeverity: none`. The invariant: a judge reviews recorded results and never
re-runs them, it must resolve to a different vendor from the worker that
actually ran the attempt, and a dead or malformed judge is a review-protocol
defect, not a verdict. See
[contract.md](../skills/faberun/references/contract.md).

## Gate (advisory, blocking, failOn, revisions)

The review policy attached to a node. A gate object accepts `runtime`, `review`
(`none`, `advisory` or `blocking`, default `advisory`), `failOn` (default
`["critical"]`) and `maxRevisions` (default 1); `gate: false` skips review.
`advisory` records the verdict and still settles `done` on deterministic
verification alone; `blocking` re-dispatches within `maxRevisions` when findings
reach `failOn`. The invariant: the revision budget counts gate rejections, not
worker starts, so a resume or a crash-restart never consumes one; validation
requires `critical` whenever `major` is in `failOn`, and `major` in `failOn` for
a `blocking` gate. See [rules.md](../skills/faberun/references/rules.md) and
[contract.md](../skills/faberun/references/contract.md).

## Definition of done and its proofs

The list of conditions a node must satisfy, one item per claim, each declaring
`id`, `text` and how it is proven. A proof is a verification `command`, a
workspace `path`, the `judgment` of a judge, or `verification` by reference to
an already recorded command result by position. `command` proofs run before any
judge, capped at `min(timeoutSec, 120s)`, and a contract-level
`finalVerification` adds the phase-wide proof. A contract-level
`sharedVerification` adds the fast repository ratchets to every node's
verification, so a node whose write set breaks one fails on its own attempt
rather than on the phase-terminal node's full suite. The invariant: every item
declares its own proof; proofs gate before any judge runs, so a fully mechanical
node costs no judge, and a schema-1 string item is rejected. An attempt killed
by a signal the controller did not itself send is retried once, with both
attempts kept in the record and the first flagged `signalDeath`. See
[contract.md](../skills/faberun/references/contract.md) and
[rules.md](../skills/faberun/references/rules.md).

## Harness, model, vendor and runtime

A runtime is one way to run a turn: `harness` names the adapter (`claude`,
`codex`, `agy`, `dsh`, `zcode`, `exec-jsonl`, `replay`), `model` names what it
asks, and the two vary independently. A vendor is the independent review
identity, resolved by `resolveVendor` in `src/harnesses/index.mjs` from an
explicit `vendor`, a provider-config override, or the harness default; `dsh`,
`replay` and `exec-jsonl` have no default and must declare one. Runtimes are
declared in `runtimes` and `runtimeDefaults` on the contract, and a runtime id
is named `<harness>-<model>`. The invariant: vendor is resolved, not inferred
from the harness name; validation rejects a gate-enabled node whose worker and
judge resolve to the same vendor, and the same for every runtime in the worker's
fallback chain. See
[contract.md](../skills/faberun/references/contract.md).

## Tier, costRank and fallback

`tier` groups runtimes for composed re-tiering, cheapest tier first; `costRank`
breaks ties within a tier; `fallback` names at most one other runtime for a
single hop taken on provider exhaustion. The invariant: a fallback is a single
hop, a self-loop is rejected outright, and validation walks for a cycle only the
fallback chain a gated worker reaches, not a chain no gated worker reaches or a
judge's; a judge fallback is admissible only when it differs in vendor from the
worker that actually ran the attempt, and budget, scope, permission or authority
failures never trigger failover. See
[contract.md](../skills/faberun/references/contract.md) and
[operations.md](../skills/faberun/references/operations.md).

## Attempt worktree

The isolated checkout one worker attempt runs in:
`.runs/worktrees/<run-id>/<node-id>.<attempt>` on branch
`faberun/<run-id>/<node-id>/<attempt>`, cut from the run ref
`refs/faberun/<run-id>/run`. The node snapshot records its `path`, `branch`,
`baseSha` and sealed `commit`; `contract.cwd` stays the home of run and control
artifacts. The invariant: every attempt gets its own worktree, and a retried
attempt never discards the previous attempt's edits, because the next attempt is
cut from the previous seal when it has a diff and from the run ref tip when it
does not. See
[operations.md](../skills/faberun/references/operations.md) and
[workflow.md](../skills/faberun/references/workflow.md).

## Seal

The commit that turns an attempt's uncommitted edits into a durable object
before anything is integrated, named for the run, node and attempt. The
controller writes it and records `empty: true` in `integration.jsonl` when the
attempt produced no diff. The invariant: an attempt's edits are sealed before
integration, an empty seal falls back to the run ref tip, and a retry continues
from the sealed sha instead of starting over. See
[operations.md](../skills/faberun/references/operations.md) and
[workflow.md](../skills/faberun/references/workflow.md).

## Integration ref and candidate

The per-run ref `refs/faberun/<run-id>/run` is the integration head. Integration
builds a candidate on `refs/faberun/<run-id>/candidate` and
`.runs/worktrees/<run-id>/.candidate`, where the node's verification runs once,
except that a command the candidate failed but the attempt passed is retried
once before the candidate is judged failed, since that disagreement is
evidence about the two worktrees rather than about the work. A passing
candidate advances the run ref with a conditional `update-ref` and
writes the node `done` with `integratedHead`; a failing candidate is removed and
leaves the run ref untouched; a conflict parks the node `attention` with the
conflicting paths. The invariant: integration is serialized, a pass advances the
ref only conditionally, and a failed or conflicting candidate never moves the
run ref. See
[operations.md](../skills/faberun/references/operations.md).

## Promotion and the landing branch

Promotion fast-forwards a campaign's landing branch (`campaign.landBranch`,
default `campaign/<campaign-id>`) onto a run's integrated ref and records a
promotion entry on the campaign. It is the only place a shared landing branch
moves, and the chain never force-updates it. The invariant: promotion requires
green `finalVerification`, refuses a landing branch that is checked out in a
worktree, and refuses `main` unless the operator passes `--allow-main`. A run
already reflected on the landing branch, including a coordinator restart
replaying that promotion after the branch has since moved further, is
reported as `already_promoted` and adds no promotion record. See
[operations.md](../skills/faberun/references/operations.md) and
[COMMANDS.md](COMMANDS.md#supervise).

## Final verification and the phase-terminal node

`contract.finalVerification` is the contract-wide proof that a phase as a whole
closes. The controller runs it on the phase-terminal node, the one node no other
node depends on, before the judge. The invariant: a phase is never approved on
partial proof, because the final verification commands are appended only for the
phase-terminal node, and their green result is the precondition for promotion.
See [rules.md](../skills/faberun/references/rules.md) and
[contract.md](../skills/faberun/references/contract.md).

## Seat

The operator's interactive surface: one tmux session, `faberun-seat`, with one
window per open campaign, managed by `seat start`, `attach`, `status` and
`stop`. It hosts an interactive harness for the operator. The invariant: the
seat never drives a run and never writes run state, because state writes stay
with the controller; a dead pane cannot touch `.runs/`, and tmux being absent
only costs reattaching. See
[operations.md](../skills/faberun/references/operations.md) and
[COMMANDS.md](COMMANDS.md#seat).

## Handoff and journal

`HANDOFF.md` is the bounded capsule an operator or a fresh session reads first:
recent intents, decisions, constraints, outcomes, the next action and open
questions. `journal.jsonl` is the append-only, fsynced narrative behind it. The
invariant: the handoff is a projection refreshed at initialization, registration,
transitions and terminal completion, while the journal is the source that is
never rewritten. See
[operations.md](../skills/faberun/references/operations.md) and
[handoffs.md](../skills/faberun/references/handoffs.md).

## Attention and parked

Attention is the state that asks a human to act: a node or campaign records an
`attention` entry with a code and a resolving command. Parked is the
campaign-level consequence, written by the chain when it cannot continue:
a run settled unsuccessful (`run_parked`, `run_canceled`), a contract that no
longer validates or was edited after authoring (`contract_validation_failed`,
`contract_authored_bytes_changed`), a run directory whose stored contract does
not match its record (`contract_digest_mismatch`), or a promotion refusal; a node's
`judge_fallback_vendor_conflict` stays inside the run's own attention, which
`run_parked` then names. The invariant: attention is a durable human boundary
rather than a failure to retry blindly, and `campaign unpark <id>` refuses a
run that is still parked or canceled unless `--force` is passed, and clears the
attention outright when the run directory no longer exists, appending a
`campaign.unparked` journal event. See
[operations.md](../skills/faberun/references/operations.md) and
[COMMANDS.md](COMMANDS.md#campaign).

## Supervise and resume

`supervise <run-dir> [--detach] [--interval <sec>]` is the watchdog above a run:
it holds no lock and writes no state, and every interval launches
`resume --detach` when a node is unfinished and no controller is live.
`resume <run-dir>` continues an interrupted run in place: same run, same node,
attempt plus one, packet frozen, adopting completed work before re-dispatching.
The invariant: the watchdog writes no state and exits once every node is
terminal, and a run is continued rather than re-authored. See
[operations.md](../skills/faberun/references/operations.md) and
[workflow.md](../skills/faberun/references/workflow.md).

## Evidence: the .runs/ layout

The durable evidence of a run lives under `<cwd>/.runs/<id>/`: `contract.json`,
`run.json`, `status.json`, `findings.json`, `nodes/<id>.json`, `logs/`,
`operations/`, `usage.jsonl`, `integration.jsonl`, `events.jsonl`,
`notify.jsonl` and `STATUS.md`; a smaller `<cwd>/.runs/status.json` pointer
carries the live summary. The invariant: stored files are state and logs are
diagnostics, raw worker output stays under `.runs/` while only status and
actionable verdicts enter the control session, and the run directory is
self-contained enough to resume. See
[contract.md](../skills/faberun/references/contract.md) and
[COMMANDS.md](COMMANDS.md#status).

## Related docs

[Getting started](GETTING-STARTED.md) is the install-to-first-campaign path.
[Architecture](ARCHITECTURE.md) maps these terms onto the module layers, and
[ADRs](adr/README.md) record the decisions behind them.
