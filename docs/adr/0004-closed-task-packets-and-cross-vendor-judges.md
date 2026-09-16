---
type: ADR
id: "0004"
title: "Closed task packets with mechanical proof and cross-vendor judges"
status: active
date: 2026-09-15
---

## Context

A worker running on an open-ended prompt explores the repository, invents its
own scope, and returns a result nobody can check cheaply. A judge drawn from
the same vendor as the worker shares the worker's blind spots and tends to
approve its own family's mistakes. Verification and revision were also
conflated: a run that re-ran commands and a run that re-dispatched a worker
consumed the same budget, so a crash-restart cost a revision it should not
have.

## Decision

**Every node carries a closed task packet, every definition of done names its
proof, and a gate-enabled node is judged by a different vendor than the one
that ran it.**

- A task packet declares `mode` (`execution`, `discovery`, `autonomous`),
  `objective`, `instructions`, `readFiles`/`writeFiles` (or, for `autonomous`,
  `writeRoots`), `symbols`, `decisions`, `nonGoals` and `verification`. Scope
  is a detector, not a sandbox: unexpected writes on an otherwise passing
  attempt stay a `scopeFindings` record; only a failed verification turns them
  into part of the failure.
- **Proof before judgment.** Deterministic `verification` commands run once
  before any judge, and the judge reviews the recorded results instead of
  re-running them. Each definition-of-done item names a `path`, a `command`, a
  `verification` index, or `judgment: true`. A mechanically provable node
  spends no judge.
- **Judge vendor rule.** A gate-enabled node must resolve its judge to a
  different vendor than the worker runtime that actually ran the attempt; the
  static case is rejected at validation and a same-vendor failover is refused
  at execution.
- **Bounded revisions.** `maxRevisions` counts gate rejections, not worker
  starts; a resume or crash-restart never consumes one.
- **No spend ceiling.** The schema has no `maxInputTokens`, `maxCostUsd` or
  `usagePolicy`; `timeoutSec`/`stallTimeoutSec` bound an attempt, and provider
  exhaustion re-tiers runtimes. `usage.jsonl` is reporting only.
- A worker whose closed context is missing the context it needs returns
  `blocked_context` with `missingContext`, never repository-wide exploration.

## Options considered

- **Open prompts with a same-vendor reviewer** (rejected): unverifiable scope
  and shared blind spots.
- **A spend ceiling or a token budget in the schema** (rejected): it would
  control by killing work, not by making it provable; timeouts bound an attempt
  and exhaustion is handled by re-tiering.
- **Closed packet, deterministic proof and a cross-vendor judge** (chosen).

## Consequences

- A worker result is bounded and machine-checked; a discovery node is the one
  deliberate exception, and only a read-only one.
- Validation rejects a statically knowable same-vendor worker/judge pair; a
  judge fallback that lands on the worker's vendor at execution is refused and
  the node parks with `judge_fallback_vendor_conflict`.
- An invocation whose effect is unknown is not retried until an explicit
  reconciliation, so a recovery never duplicates an effect.
- Writing a contract requires measuring the verification commands, because the
  judge and the run pay for an unmeasured one.

## References

- [SPEC.md](../campaigns/become-faberun/spec/SPEC.md) — *Decisions already
  made* → *No spend ceiling* and *Onboarding* (the judge must resolve to a
  different vendor), and *Operating rules*.
- [contract.md](../../skills/faberun/references/contract.md) — *Task packets*,
  *Worker results*, *Gates*, *Runtimes and routing*, *Failover*.
- [AGENTS.md](../../AGENTS.md) — *Faberun protocol*.
- [operations.md](../../skills/faberun/references/operations.md) — *Attempt
  worktrees*, *Integration transaction*.
