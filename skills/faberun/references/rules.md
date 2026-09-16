# Load-bearing rules

**One contract per approved plan step.** Inspect the repository once, then
author every node of the step with its `dependsOn` edges in a single turn.
Serial micro-contracts keep the expensive control session alive for the whole
physical runtime. Use `mode: "discovery"` only when no packet is possible.

**Prove mechanically.** Every Definition of Done item is an object declaring
its own proof: a verification `command`, a workspace `path`, or `judgment`.
Proofs gate before any judge runs, so a fully mechanical node costs no judge.
Contract-level `finalVerification` runs on the phase-terminal node;
`sharedVerification` runs on every node, so a ratchet-breaking write set
fails on its own attempt.

**Never wait inside a turn.** No `sleep`/`while` loops, no repeated `status`
calls, no watched background jobs — every tool call re-sends the whole session
context. Check status once per invocation, report one line, end the turn.
Interrupt the user only for `blocked`, `failed`, `exhausted`, `stalled`, or
completion.

**No spend ceiling.** `timeoutSec` and `stallTimeoutSec` bound an attempt;
there is no `maxInputTokens`, `maxCostUsd`, or `usagePolicy`. A spent provider
allowance is handled by runtime re-tiering and discovery
([contract.md](contract.md)), never a ceiling the operator had to guess. Usage
is recorded per attempt in `usage.jsonl` for reporting only.

**Gates.** The judge reviews captured results instead of re-running them.
Default `failOn` to `critical`, set `maxRevisions` explicitly, keep judge and
worker runtimes different. After two rejections or an exhaustion, create one
targeted fix node from the verbatim finding — never copy the graph.

Express model choice only in `runtimes`, `runtimeDefaults`, or an explicit
node override — never as model-specific branches in prose. Resolution order
and the single-hop fallback edge: [contract.md](contract.md).

Stop and ask before destructive production, data, merge, deployment, or
credential operations, even if a worker proposes them.
