# Contract reference

Node.js 22+, plain ESM `.mjs`; TypeScript is development-only (`npm run
typecheck`). Schema version is `3`.

## Shape

```json
{
  "schemaVersion": 3,
  "contractVersion": "0.3.0",
  "id": "feature-42",
  "campaignId": "feature-42",
  "goal": "Deliver feature 42 with tests",
  "cwd": "../target-repo",
  "maxParallel": 1,
  "stallTimeoutSec": 300,
  "timeoutSec": 2400,
  "runtimeDefaults": { "worker": "flash", "judge": "sol" },
  "runtimes": {
    "flash": { "harness": "dsh", "model": "deepseek-flash", "reasoning": "high",
      "vendor": "deepseek", "sandbox": "danger-full-access",
      "config": { "provider": "deepseek-official", "api_key.env_key": "DEEPSEEK_API_KEY" } },
    "luna": { "harness": "codex", "model": "gpt-5.6-luna", "reasoning": "xhigh" },
    "sol": { "harness": "codex", "model": "gpt-5.6-sol", "reasoning": "xhigh" },
    "opus": { "harness": "claude", "model": "opus", "permissionMode": "acceptEdits" },
    "zcode-flash": { "harness": "zcode", "model": "glm-5.3-flash", "permissionMode": "edit" },
    "agy-flash": { "harness": "agy", "model": "gemini-3.8-flash-low" }
  },
  "nodes": [
    {
      "id": "implementation", "type": "backend", "phase": "implementation",
      "taskPacketFile": "packets/implementation.json", "dependsOn": [], "timeoutSec": 2400,
      "definitionOfDone": [
        { "id": "behavior-implemented", "text": "The requested behavior is implemented",
          "proof": { "kind": "command", "ref": "npm test" } },
        { "id": "diff-scoped", "text": "No unrelated files changed",
          "proof": { "kind": "path", "ref": "src/feature-42.ts" } },
        { "id": "design-honored", "text": "The change honors the stated design decisions", "judgment": true }
      ],
      "gate": { "failOn": ["major", "critical"], "maxRevisions": 1 }
    }
  ]
}
```

Every `definitionOfDone` item declares `id`, `text`, and how it is proven:
`proof.kind` `command` (re-runs the command through a shell, bounded by the
node's own `timeoutSec`; quote a flag value containing spaces, which
`verification`'s argv does not need and a shell splits) or `path` (a file must
exist), or `judgment: true` for the judge. `proof: {
kind: "verification", ref: <index> }` reuses a `verification` entry's already
recorded result by position instead of re-running it — never by comparing argv
strings, since a joined argv loses shell semantics. A schema-1 string item is
rejected. There is no spend ceiling in the schema: no `maxInputTokens`,
`maxCostUsd`, or `usagePolicy`. `timeoutSec` and `stallTimeoutSec` bound an
attempt; a spent allowance is handled by runtime re-tiering (below). `usage.jsonl` records
tokens and cost per invocation for **reporting only** — no control path reads
it.

At the contract level, `sharedVerification` is the same command schema as
`finalVerification`, appended to every node's attempt and integration-candidate
verification after the packet's own commands and before `finalVerification`,
which only the phase-terminal node carries. Declare it for the fast repository
ratchets (source shape, field ownership, brand, docs diet): a node whose write
set breaks a rule then fails on its own attempt instead of on the
phase-terminal node's full suite. Both sets count in the node budget and in
`preflight --time-verification`.

## Task packets

```json
{
  "mode": "execution",
  "objective": "One concrete outcome",
  "instructions": ["Exact behavior to implement"],
  "readFiles": ["src/feature.ts"],
  "writeFiles": ["src/feature.ts"],
  "symbols": ["runContract"],
  "decisions": ["Decision already made; do not reopen"],
  "nonGoals": ["Explicitly excluded work"],
  "verification": [{ "argv": ["node", "--test", "test/feature.test.mjs"] }]
}
```

`mode` is `execution`, `discovery`, or `autonomous`. `objective`,
`instructions`, and `verification` are required and non-empty. An execution
packet requires non-empty `readFiles` and `writeFiles`; read paths are
relative to `cwd`, cannot escape it, and must exist at validation time —
except contract loading defers a missing `readFiles` or `scopeAcknowledged`
entry a transitive dependency declares in its `writeFiles`, or that sits under
its directory-shaped `writeRoots` entries (a file-shaped entry authorizes only
that exact path); every other caller still rejects the
missing read. A
discovery packet has empty `writeFiles`; with an empty `readFiles` it may
read the repository read-only to produce an execution packet — the one
exception to closed scope — otherwise it is closed to the listed files. Each
`verification` entry is `{argv, cwd?, timeoutSec? (default 120, max 600),
repeat? (default 1, max 8), env?, requirementId?}` — at most 32 commands, 64
argv items, 32 KiB argv bytes per command. `requirementId` names the spec
requirement this command proves, changing nothing about how it runs: it is
what lets `contract validate` report two copies of one proof that have stopped
agreeing. `env` declares variable *names* only; values
never travel in the packet. `prompt`/`promptFile` are
rejected; a node has `taskPacket` or `taskPacketFile`, never both. Measure a
candidate command's real duration before naming it in `verification` or a
worker instruction — `preflight <contract.json> --time-verification` runs each
declared command once and fails the contract when it cannot fit that timeout.

An `autonomous` packet declares `writeRoots` instead of `writeFiles`:
whole-repo read, write bounded to the listed files/directories. Scope is
advisory, not a gate: a completed attempt whose worker result and
verification both pass keeps unexpected writes as a `scopeFindings` entry and
still reaches `done`; only a failed verification turns the unexpected paths
into part of the failure. Redirect a toolchain's cache/build output under
`.runs/` (git-ignored, outside the snapshot).
The workspace snapshot skips `.runs`, `.git`, `node_modules`, `.claude`,
`.codex` at the repository root.

The stored `contract.json` inlines every packet (dropping `taskPacketFile`
and the generated prompt) and carries a `packetHash` the runner validates on
load, so a run directory is a self-contained resumable record.

## Worker results

```json
{
  "status": "done",
  "summary": "Implemented the described behavior",
  "changedFiles": ["src/feature.ts"],
  "verification": ["node --test test/feature.test.mjs"],
  "artifacts": [],
  "missingContext": []
}
```

`status` is `done` (empty `missingContext`) or `blocked_context` (at least one
`missingContext` entry) — the only response when the closed context is
missing something, never repository-wide exploration. Bounded: 32 KiB total,
4 KiB summary, 32 entries each in `changedFiles`/`verification`/`artifacts`
(16 in `missingContext`), 2 KiB per entry (16 KiB per artifact). Unknown
provider-added fields are dropped; missing/malformed canonical fields are
rejected (`worker-result.mjs`). A discovery node returns `done` with exactly
one `artifacts` entry: the execution packet for the next node.

## Runtimes and routing

Resolve a worker as `nodes[].runtime`, then `runtimeDefaults.worker`; a judge
as `nodes[].gate.runtime`, then `runtimeDefaults.judge`, then a contract's (or
absent one, the machine config's) ordered `judges` list: its first entry off
the worker's provider and its fallback chain's, unrefused and under a 90%
usage window, hopping the same way on a later refusal without repeats,
replacing any declared `fallback` edge outright, and blocking the node by name
when every entry is skipped (R18).
When `runtimes` and `runtimeDefaults` are both omitted, the factory composes
them from the discovery catalogue (`DISCOVERY_RUNTIME_DEFINITIONS`:
`dsh-deepseek`, `zcode-glm`, `agy-gemini` at tier 1, `codex-gpt` and
`claude-sonnet` at tier 2; available when the binary answers and every
`config["*.env_key"]` it names is set): the cheapest available runtime
executes, the strongest runtime of a *different vendor* judges, persisted in
`routing.assignments`; no admissible cross-vendor judge fails by name
(`runtime_assignment_judge_unavailable`).

`harness` names the adapter that runs the turn (`claude`, `codex`, `agy`,
`dsh`, `zcode`, `exec-jsonl`, `replay`) and `model` what it asks; the two vary
independently — DeepSeek answers through `dsh`, GLM through `zcode`. Name a
runtime id `<harness>-<model>` so a recorded run says which harness produced
it; ids take letters, numbers, dot, underscore, dash only. Vendor is the
canonical provider (`canonicalProvider` in `src/contract/provider.mjs`)
derived from route, model family, or harness default (`claude`→anthropic,
`codex`→openai, `agy`→google, `zcode`→zhipu; `dsh`/`replay`/`exec-jsonl` have
none and must declare `vendor`), falling back to `resolveVendor` only when it
derives none; a declared `vendor` that contradicts it is refused. Validation
rejects a gate-enabled node whose worker and judge resolve to the same
vendor, and does the same for every runtime in the worker's declared fallback
chain (rejecting a cycle outright). The symmetric case for a judge fallback
depends on which worker runtime ran and is refused at execution instead; see
Failover below.

An optional `runtimes[<id>].pricing` object declares `inputPerMTok`,
`cachedInputPerMTok`, and `outputPerMTok` (each finite and >= 0, at
least one required, unknown keys rejected) and prices that runtime's canonical
counters when the harness reports no cost; a missing counter stays `unknown`,
never zero.

Non-empty `taskPacket.verification` is rejected when the resolved worker or a
worker fallback cannot execute commands. Adapters declare
`permissionExecution`: `claude` only `bypassPermissions` (default
`acceptEdits`), `zcode` only `yolo` (also default), `dsh` both its default
`workspace-write` (measured: executes and writes inside the worktree) and
`danger-full-access` (only for effects outside it); every `codex` sandbox mode
executes, and `agy`/`exec-jsonl`/`replay` expose no denying mode. Each adapter
also declares `signalsProcesses` (`true`, `false`, or `null` when unmeasured):
a worker whose adapter declares `false` gets a `## Sandbox` prompt warning not
to run tests that start and terminate child processes, and
`requiredCapabilities.signalsProcesses: true` admits only an adapter declaring
`true`. Judge modes
are excluded because judges review captured results.

- `claude`: `permissionMode` (a node that runs commands needs
  `bypassPermissions`, or the worker can only return `blocked_context`).
  Executable
  override: `executable` or `FABERUN_CLAUDE_BIN`. It disables slash
  commands, MCP, and settings files on every invocation and restricts tools to
  `runtime.tools` (default `Read, Edit, Write, Bash, Glob, Grep`); `--bare` is
  never used because it also disables the tool-policy hook.
- `codex`: `sandbox` (`read-only`, `workspace-write` default,
  `danger-full-access`); arbitrary `config` entries serialize as `-c
  key=value`; disables browser/computer-use/app/sub-agent tooling and MCP by
  default (`CODEX_PREAMBLE_OVERRIDES`). Executable override: `executable` or
  `FABERUN_CODEX_BIN`. A profile name never selects a custom provider:
  Codex accepts unknown profiles silently.
- `zcode`: the GLM route — Z.ai's own harness CLI, driven headlessly
  (`zcode --prompt --json`; `executable` / `FABERUN_ZCODE_BIN` override).
  Model and endpoint travel
  as `ZCODE_MODEL` (`config.provider`/model, default `glm`/model; a `[1m]` model
  suffix is stripped — the provider reports the context window itself) and
  `ZCODE_BASE_URL` (default the Z.ai Anthropic-compatible endpoint); the token
  rides the provider-derived `${PROVIDER}_API_KEY` variable built from
  `config["auth_token.env_key"]` (default `ZAI_API_KEY`). `permissionMode`
  maps to `--mode` (`build`/`edit`/`plan`/`yolo`; default `yolo` — a judge
  runtime declares `plan`). No schema flag and no tool policy, and the CLI's
  `--settings`/hooks surface stays unwired:
  `structuredOutput`/`toolPolicy` are `false`, judges arbitrate through the
  prompt-embedded schema, and a `toolPolicy` requirement rejects the runtime.
  Continuation resumes `sess_…` ids. Mid-run metering reads zero; usage
  settles from the terminal result.
- `agy`: the installed `agy` CLI (or `FABERUN_AGY_BIN`); optional
  `printTimeout`; omit `reasoning` for models without `--effort`.
- `dsh`: the DeepSeek Harness through the shipped `sdk` JSON-RPC client;
  `headless` drops usage. Normalization assumes streamed `inputTokens` excludes
  `cacheReadTokens`; `usage.jsonl` records it unchanged as uncached input.
  `config.provider` is required (`deepseek-official`); `model` and `reasoning`
  pass through verbatim. Its catalogue is the one `models` prints
  (`deepseek-flash` is the default); unknown ids fail in the harness.
  Authentication stays in `DEEPSEEK_API_KEY`;
  `config["api_key.env_key"]` only names it for `preflight`. `sandbox` maps to
  `DSH_PERMISSION_MODE`, default `workspace-write` (above). Every attempt loads
  `dsh/closed-packet.patch.yml`; `config.patch` stacks one layer. Executable
  override: `executable` or `FABERUN_DSH_BIN`. No default vendor,
  continuation (`session/resume` is ACP-only), or native schema flag; the judge
  schema travels in the prompt.
- `exec-jsonl`: generic harness for a JSONL-protocol executable — one
  `run.request` on stdin, `run.started`/`message`/`run.completed`/
  `run.failed` on stdout. Set `executable` (or
  `FABERUN_EXEC_JSONL_BIN`), `args`, `versionArgs` when `--version` is
  unsupported.
- `replay`: stands in for any provider in tests — recorded, already-normalized
  envelopes, zero model calls. `config["replay.recording"]` names a JSONL
  recording consumed strictly in order via a `.cursor` sidecar; each consumed
  line appends one record to `<recording>.invocations.jsonl`. A missing line
  emits `replay_exhausted` (exit 1); a path escape in `files` emits
  `replay_path_escape` (exit 2) and writes nothing.

Continuation is capability-gated (`codex`, `claude`, `zcode`, `agy`,
`exec-jsonl`, `replay` all declare it) and requires an exact fingerprint of
the runtime definition; a runtime change, a failover hop, or an adapter
without the capability starts a fresh session carrying prior structured
summaries forward, never a continuation ID.

### Failover

`runtimes[<id>].fallback` names at most one other runtime id — the single hop
a role takes on provider exhaustion at execution time; a self-loop is
rejected outright. Runtimes can chain (a fallback whose fallback names a third,
and so on); validation walks that chain for a gated worker and rejects a cycle,
but does not walk a chain no gated worker reaches, or a judge's. `tier` groups runtimes
for composed re-tiering (cheaper tiers first); `costRank` breaks ties. A
worker fallback is taken unconditionally once reachable and unattempted this
revision. A judge fallback is admissible only when it differs in vendor from
the worker runtime that actually ran the attempt; a same-vendor fallback is
refused and the node parks `attention` with
`judge_fallback_vendor_conflict`. Either role exhausting its one-hop budget
without an admissible target ends `exhausted` (worker) or `attention` (judge)
with `runtime_tier_exhausted`, preserving any announced `exhaustedUntil`.
Budget, scope, permission, and authority failures never trigger failover.

When an exhaustion envelope announces `resetAt` strictly after now and
strictly before the node's own deadline, the controller waits for it on the
same runtime instead of taking an edge; a reset outside that window, or none
announced, takes the declared/synthesized edge. A wait is not a hop and does
not consume the failover budget.

`doctor --discover [--json]` normalizes each harness's exhaustion signal into
`{available, exhaustedUntil, reason}` (missing CLI → `not_found`; auth
failure has no reset; a quota response keeps its reset, including Z.ai code
1310).

## Graph and states

`dependsOn` forms a DAG; a node starts once every dependency is `done`, and a
failed terminal dependency makes it `blocked`. Terminal states: `done`,
`no-op`, `blocked`, `failed`, `exhausted`, `stalled`, `canceled` — every node
ends in exactly one. `stallTimeoutSec` bounds silence on stdout/stderr, but
only for a harness declaring `streamsOutput` (true for `codex`, `claude`,
`agy`, `dsh`; false for `zcode`, which dumps its turn at exit);
others fall back to `timeoutSec` alone.
`timeoutSec` (default 2400s) caps one invocation and may be overridden per
node; a node is bounded by `(1 + maxRevisions) × 2 × timeoutSec`. Both clocks
are monotonic and pause with host suspend.
`maxTurns` (default 150) bounds something else: the *provider requests* one
attempt may make, overridable per node. Reaching it ends the attempt with
`errorCode: turn_limit`, sealed then retried once, the spend already spent. It
bites the nodes that read much and write little — review, synthesis — so raise
it there; raising `timeoutSec` does not help. The controller says so once at
80%, and `usage.jsonl` records each invocation's `session.requests`.
`maxParallel` above 1 dispatches
every dependency-ready node concurrently, each into its own attempt
worktree; integration stays serialized. Nodes of one phase need no edge
between them: a continuation a live invocation already claims is never
offered to a second node, so one session runs one turn.

## Gates

`gate: false` skips review; the node keeps `maxRevisions` (default 1) fresh
attempts after a red verification, and `{ enabled: false, maxRevisions: 0 }`
makes the first red one final. A gate object accepts `runtime` (the judge),
`review` (`none`/`advisory`/`blocking`, default `advisory`), `failOn`
(default `["critical"]`) and `maxRevisions`. `advisory` records the verdict
and still settles `done` on deterministic verification alone, never
re-dispatching; `blocking` re-dispatches within `maxRevisions` when findings
reach `failOn`. Validation requires `critical` whenever `major` is in
`failOn`, and `major` in `failOn` for a `blocking` gate: `["critical"]` alone
passes every major finding.

The revision budget counts rejections, not worker starts; a resume or a
crash-restart never consumes one. Deterministic `verification` commands run once by default
before any judge and the judge reviews the recorded results, never
re-running them (`repeat` opts into re-running a flaky check). A judge
output is `pass` only with empty `findings` and `maxSeverity: none`; for
Codex judges, normalization selects the last parseable JSON agent message.
Zero or multiple verdict-shaped messages, a dead judge, or a wall-clock kill
is a review-protocol defect, not a verdict — one bounded re-ask; if that
also fails, advisory review completes `done` with `gate.verdict:
invalid_judge_output`, while blocking review marks the node `blocked` with
`judge_unavailable`, preserving the worker result and verification for
`resume` to re-judge. There is no first-class `stopped` state: model a
falsification gate as a node whose Definition of Done requires a durable
stop artifact and a fail-closed check, and do not schedule descendants after
it is accepted.

## Run artifacts

Under `<cwd>/.runs/<id>/`:

```text
contract.json  run.json  status.json  findings.json
nodes/<id>.json
logs/<id>.<attempt>.<worker|judge>[.r<n>].jsonl / .err
operations/<invocationId>.intent.json / .settlement.json
usage.jsonl  integration.jsonl  events.jsonl  notify.jsonl  STATUS.md
```

`operations/` holds the exact-once intent/settlement record for every
provider invocation, written before dispatch and merged idempotently after:
`settled` means a known harness outcome; `unknown_effect` means the request
may have run without proof and is not permission to retry. Replay of an
unknown-effect window needs `replayPolicy: "safe"` (default) plus a clean
persisted scope across the window and passing verification; otherwise it
settles `reconciled` and blocks the node with `unknown_effect_reconciled` — a
durable manual-stop attention boundary. All writes happen under the
controller lock. `usage.jsonl` is one line per invocation: tokens by kind
(uncached input, cache read, output), `costUsd` with provenance (`priced`, else
`provider`, else `unknown`), timestamps. See
[operations.md](operations.md) for worktrees, integration, `status.json`,
notify, the controller lock, and campaigns.

## Resume

`resume <run-dir>` continues an interrupted run in place: same run, same
node, attempt plus one, packet frozen. It adopts completed work first — a
worker log proving the turn finished recovers an orphaned provider process,
and a node `blocked` with `judge_unavailable` is re-judged from the
preserved result, never re-dispatched to a worker. Only then does it
re-dispatch ordinary failures (`failed`, `stalled`, `canceled`,
wall-clock-`exhausted`, `blocked`/`dependency_failed`) as attempt plus one,
with a bounded `## Previous attempt` section (prior error, judge/scope
findings, failing commands) appended to the regenerated prompt.
`resume --node <id>` limits the retry to that node and its dependents.

`resume --answer <node-id>=<path>` records an operator's answer for a node
`blocked` with `context_missing`, then re-dispatches it and its dependants,
narrowed exactly like `--node`. The file is read once, relative to the
shell's own cwd rather than the contract's, refused above 8 KiB, and
persisted as an `operator-answer` execution override (`kind`, `at`, `reason`,
a bounded `text`) — the authored packet and `packetHash` untouched, and a
repeated answer appends rather than merges. A malformed value, an unknown
node, an unreadable or oversized file, or a node not blocked on missing
context each refuse with their own message. The answer is text only, never
written into the attempt worktree.

`unknown_effect_reconciled` is re-dispatched only with an explicit
`--reconcile <node-id>`. Resume accepts a current `HEAD` that is a
descendant of the recorded `gitHead` (workers and the orchestrator commit
between attempts) and records the new head; a non-descendant is refused. A
`dirtyTreeFingerprint` mismatch is a status warning, not a refusal.

## Environment doctor, cancel, JSON status

`doctor [<contract.json>] [--cwd <dir>] [--json]` is mutation-free: checks
`cwd` is a git work tree, `.runs/` is ignored, `node`/`npm` are on `PATH`,
and — with a contract — every routed harness exists and probes cleanly.
`cancel <run-dir>` signals the controller (`SIGTERM` then `SIGKILL` after
2s), takes over its now-stale lock, terminates every recorded invocation,
and marks the run terminal; it cannot act on a lock held by its own process.
`status --json`/`report --json <run-dir>` emit stable `schemaVersion: 1`
payloads for streaming monitors instead of `STATUS.md`.
