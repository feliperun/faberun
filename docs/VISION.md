# Faberun vision

Faberun is a development orchestration system that turns intent into verified
software. It sits above the coding agents rather than beside them: it keeps the
intent, coordinates the work, tracks what was actually completed, validates the
result, and decides what happens next.

Faberun joins *faber* (Latin: maker, craftsman, builder) and *run* (what
software does). The name marks the transition from making to running.

## Why this, why now

Coding agents can already write code. The work around that code is still held
together by a person re-explaining the plan every session. A long plan lives in
one context, its execution in another, and its proof in a third; when a session
ends or a provider runs out of allowance, the state is reconstructed by hand.

At the same time, the tools keep changing. Claude Code, Codex, OpenCode and
whatever comes next are workers. Claude, GPT, Gemini, DeepSeek and GLM are
engines. Anything built tightly around one of them has a short life. The moment
to put the orchestration layer above them is now, while the layer below is
still moving.

## The problem

The operator of a large implementation plan has no durable place to put the
intent. Every execution step starts from a prompt, not from a recorded
objective. Progress is measured in prose, not in work actually completed.
Verification is the model's own summary, so a change that looks right can land
without proof that it runs.

The failure modes are ordinary and expensive. A dead controller stops the whole
plan. A spent provider allowance kills a node that was making progress. A retry
throws away the previous attempt's edits. An interrupted run is re-authored
instead of continued. None of them is a defect in the requested behaviour, and
each one costs a full attempt.

## The insight

Orchestration belongs outside the workers. Keep the intent above the tools,
prove each unit mechanically before a judge sees it, and let the models and
harnesses be replaced without losing the work.

The bet is that a small, deterministic control loop over a durable record beats
a longer prompt. A craftsman does not depend on one hammer: software should be
built, not merely generated. Tools can change, models can change, harnesses can
change, and the work remains.

## Principles

- **Closed packets.** Every node declares the exact files it reads, the files
  it writes, and the commands that prove it. A worker that lacks context returns
  the structured `blocked_context` result instead of exploring.
- **Mechanical proof before judgment.** Every definition-of-done item declares
  its own proof. A command or path proof gates before any judge runs, so a
  fully mechanical node costs no judge.
- **Cross-vendor review.** A gate's judge resolves to a different vendor from
  the worker that ran the attempt. Validation rejects a same-vendor pairing.
- **No spend ceiling, bounded attempts.** `timeoutSec` and `stallTimeoutSec`
  bound one attempt. A spent provider allowance is handled by re-tiering and
  fallback, never by a budget the operator had to guess.
- **History is never rewritten.** `docs/history/`, `docs/campaigns/` and
  `evals/golden/` keep what a worker was actually told. A rename or a fix
  applies to the live tree only.
- **Zero runtime dependencies.** The CLI is plain ESM `.mjs` on Node; the type
  check is development-only. Nothing is fetched to run it.

## Near-term horizon

The first Faberun release comes out of the `become-faberun` campaign. The
campaign moves the source to the repository root, renames the tool, adds
`setup`, `init`, `update` and `skills`, and writes the user-facing docs,
including this one.

Done means a released `vX.Y.Z` from the release pipeline, an `install.sh` that
installs it on a fresh machine, and an operator who can go from install to a
first finished campaign by following [GETTING-STARTED.md](GETTING-STARTED.md).
The campaign lands its branch on `main` after the full suite passes once more.

## Non-goals (for now)

- Publishing to npm; transferring the repository to the `faberun` organisation.
- Windows support for `install.sh`; a PowerShell installer is a follow-up.
- Restyling the web dashboard to the `DESIGN.md` palette.
- Any change to the contract schema or the judge protocol.
- Becoming another coding agent, or generating code without a definition of
  done.

## Related docs

[Concepts](CONCEPTS.md) · [Architecture](ARCHITECTURE.md) ·
[Getting started](GETTING-STARTED.md) · [Command manual](COMMANDS.md) ·
[ADRs](adr/README.md) · [Design system](../DESIGN.md)
