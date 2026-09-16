---
type: ADR
id: "0005"
title: "The repository becomes the Faberun CLI"
status: active
date: 2026-09-15
---

## Context

The tool lived inside a personal skills catalogue, under a directory named for
the old project, and the catalogue README described the catalogue rather than
the tool. The owner asked to rename the project and command to Faberun, move
the source to the repository root, keep the commit history, reorganise the
tree, keep the skills as CLI features, and keep the agent kit optional. A
campaign contract under `docs/campaigns/` is a record of what a worker was
actually told, so it cannot be rewritten to match the new name; the same is
true of golden eval fixtures tied to their own parent commits.

## Decision

**The repository is the home of the `faberun` command.** `src/`, `test/`,
`evals/`, `bin/` and `integrations/` sit at the root; `bin/faberun.mjs` is the
entry point; `package.json` is named `faberun`. Skills live at
`skills/<name>/` — `skills/faberun/` (the orchestrator skill: `SKILL.md` plus
`references/`) and `skills/init-agentkit/` — and the agent kit is optional,
installed per repository. `docs/` is user-facing; `docs/history/` and
`docs/campaigns/` stay dated record. **History is never rewritten:**
`docs/history/**`, `docs/campaigns/**` and `evals/golden/**` keep the old name;
the rename is enforced on the live tree by `test/repo/brand.test.mjs`. The move
used `mv` inside the worker sandbox (which cannot write the shared `.git`), so
git's rename detection preserves `git log --follow` on the sealed commit.

## Options considered

- **Keep the tool under the skill folder and copy it to the root later**
  (rejected): two sources of truth, and the copy breaks `git log --follow`.
- **Move to the root, keep history, make the skills CLI features** (chosen).
- **Rewrite history and the dated documents** (rejected): a contract records
  what a worker was told, and rewriting it makes the record a lie about a run
  that already happened.

## Consequences

- One source tree, one entry point, one package: `faberun`.
- An old path in a historical contract resolves to today's file through
  [docs/history/README.md](../history/README.md), which the record points to
  instead of being edited.
- The name is test-backed: a live occurrence of the old name fails
  `test/repo/brand.test.mjs`.
- `bulk-read` is a CLI command, not a skill folder; the agent kit is offered by
  `faberun init` rather than required by the repository.

## References

- [SPEC.md](../campaigns/become-faberun/spec/SPEC.md) — *What the owner asked
  for* items 1, 2, 4 and 7, and *Decisions already made* → *Name and package*,
  *Layout*, *History is not rewritten*, *Moves preserve history*.
- [docs/history/README.md](../history/README.md) — *Moved to the repository
  root, 2026-09-15*.
- [AGENTS.md](../../AGENTS.md) — *Source tree rules*.
