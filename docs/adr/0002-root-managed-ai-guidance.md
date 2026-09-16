---
type: ADR
id: "0002"
title: "Root-managed AI guidance files"
status: active
date: 2026-09-15
---

## Context

Several AI coding tools each look for their own instruction file at the
repository root. Maintaining `CLAUDE.md`, `GEMINI.md`, `CURSOR.md` and
`AGENT.md` as separate documents means every guardrail change has to land in
each of them; in practice one is updated and the rest drift, so different agents
work under different rules in the same repository. Faberun also needs a durable
place to tell a fresh session what work is already in flight.

## Decision

**`AGENTS.md` at the repository root is the canonical guidance for
contributors and agents. `CLAUDE.md`, `GEMINI.md`, `CURSOR.md` and `AGENT.md`
are symlinks to it.** Guidance changes land once, and drift is impossible by
construction. The bottom of `AGENTS.md` carries a managed block delimited by
`<!-- faberun-active:start … -->` and `<!-- faberun-active:end -->`: faberun
writes it with the active campaign, parked runs, error codes and the command
that resolves each one, and a reader never edits it by hand.

## Options considered

- **`AGENTS.md` canonical plus symlinks** (chosen): one source of truth, and
  the ecosystem is converging on the `AGENTS.md` name.
- **`CLAUDE.md` only**: works for Claude Code, but the other tools miss the
  shared guardrails.
- **A full file per tool**: guaranteed drift, and the guardrails are exactly
  the part that must not differ per tool.

## Consequences

- A change to workflow, checks or guardrails edits `AGENTS.md` once.
- The managed block is the continuity signal: before starting work an agent
  checks `.runs/` and the block, and continues or resumes instead of starting
  over.
- Templates under a skill's `templates/` stay generic and portable; the root
  file is not a template.
- A platform without symlink support falls back to a regen step from the
  agent-kit installer.

## References

- [AGENTS.md](../../AGENTS.md) — *Repository rules*, *Faberun protocol* and
  *Source tree rules*.
- [SPEC.md](../campaigns/become-faberun/spec/SPEC.md) — *Decisions already
  made* → *Onboarding* (managed block markers `faberun-active`) and
  *Operating rules*.
- [operations.md](../../skills/faberun/references/operations.md) — *Campaigns*.
- Agent-kit template `skills/init-agentkit/templates/docs/adr/0002-root-managed-ai-guidance.md`.
