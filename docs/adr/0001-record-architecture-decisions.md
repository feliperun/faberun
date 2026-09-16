---
type: ADR
id: "0001"
title: "Record architecture decisions"
status: active
date: 2026-09-15
---

## Context

Faberun grew out of a personal skills catalogue, so its early decisions live in
chat history, commit messages and campaign records. The repository now has
multiple contributors, human and agent, and the user-facing documentation moved
into the `init-agentkit` structure: vision, architecture, getting started and
ADRs. `docs/ARCHITECTURE.md` states what the code does now; nothing stated why
the layers, the process model and the distribution look the way they do, and an
agent reading only the tree cannot tell an active choice from an accident.

## Decision

**Record every structural choice as an Architecture Decision Record in
`docs/adr/`.** Each decision is one numbered file with YAML frontmatter
(`type`, `id`, `title`, `status`, `date`); a changed decision supersedes the
prior ADR instead of editing it, so an `active` file is immutable.
`docs/ARCHITECTURE.md` summarizes the active decisions, and
`docs/adr/README.md` is the index and the format.

## Options considered

- **ADR folder with frontmatter** (chosen): versioned beside the code it
  explains, so a decision and its implementation move together; the frontmatter
  is machine-readable, so agents can filter by status; the index lives in
  `README.md`.
- **History docs only**: lighter, but a retrospective records what happened,
  not the irreversible choice that caused it; the two belong in different
  directories.
- **An external wiki**: fine for product prose, but it breaks the coupling
  between a decision and the commit that implements it.

## Consequences

- A structural change adds or supersedes an ADR in the same commit that changes
  `docs/ARCHITECTURE.md`.
- `docs/history/` and `docs/campaigns/` stay historical record; an ADR explains
  the present without rewriting them.
- Agents can read `docs/adr/` before a large refactor, and the index answers
  "which decisions are active" without opening every file.

## References

- [SPEC.md](../campaigns/become-faberun/spec/SPEC.md) — *What the owner asked
  for* item 4, and *Decisions already made* → *History is not rewritten*.
- [DESIGN.md](../../DESIGN.md) — *Documentation*.
- [docs/history/README.md](../history/README.md).
- Agent-kit template `skills/init-agentkit/templates/docs/adr/README.md`.
