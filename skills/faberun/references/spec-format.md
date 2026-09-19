# Spec format reference

Format version `1`. A spec is the free-form input the operator hands the
planner; this is the structured shape it validates against
(`faberun spec validate`, no model invoked). A document without the front
matter below is classified `legacy` and accepted, not rejected — the
validator says so explicitly, so old campaign records keep working.

## Front matter

```yaml
---
id: kebab-case-campaign-id
title: "Human-readable title"
version: 1.1.0
status: draft
date: 2026-09-17
owner: Author Name
target: org/repo
baseline: <git sha the spec was measured against>
---
```

`id`, `title`, `version`, `status`, `date`, `owner`, `target`, `baseline` are
required. `derived_from` and `followed_by` are optional cross-references to
other spec ids (a prior spec this one revises, or the campaign meant to
follow it).

## Sections

Mandatory, in order: **Intent**, **Requirements**, **Non-goals**. The
reference proposal
(`docs/campaigns/spec-format-and-planning-stages/spec/PROPOSAL.md`) writes
these as `Intenção`, `Requisitos`, `Não-objetivos` — the section role is what
matters, not the language of the heading text.

- **Intent** — prose: why this work, what problem, what it unblocks.
- **Requirements** — one `### R<n>. <title>` block per requirement (see
  below).
- **Non-goals** — a bullet list of what this spec explicitly excludes, so a
  planner never infers scope from silence.

Optional sections, any subset, any order after Non-goals:

- **Constraints** — bullets binding every requirement at once (e.g. "no node
  runs the full suite").
- **Success criteria** — a table with at least a `Baseline` column, so
  validation can catch a metric nobody measured before claiming a delta.
- **Risks** — a table of risk / impact / mitigation.

## Requirement shape

```markdown
### R7. Repo facts are deterministic and carry measured duration

- **statement:** the target repo inventory is generated without invoking a
  model, is identical across two runs at the same HEAD, and every candidate
  verification command carries a duration measured by
  `preflight --time-verification`.
- **proof:** command: node --test --test-name-pattern="repo facts"
```

`R<n>` is a stable id — never renumbered once referenced elsewhere (a
comparative arm, a follow-up spec). `statement` is the testable claim.
`proof` is exactly one of:

- `command: <shell command>` — re-run it, exit zero proves the requirement.
- `path: <repo-relative path>` — the file or directory must exist.
- `judgment: true` — no deterministic check; a reviewer decides.

A requirement may add its own `- **constraints:** ...` line for a rule
scoped to it alone, distinct from the spec-wide Constraints section.

A requirement may also declare a measurement with
`- **measure:** command: <shell command>` — a read-only check the planner
runs against the repository *before* drafting anything, folded into the repo
facts the draft stage reads. The distinction from `proof` is timing: `proof`
is what the finished node satisfies, while `measure` is checkable before any
node exists — a grep, a `wc -l`, a small pipeline, run through the shell
exactly as written here, pipes included. Only the `command` kind is wired;
`path` and `judgment` measures parse but run nothing.

## What `faberun spec validate` checks

Deterministic, no model call. Rejects:

- a requirement without a stable id, or without a `proof` line;
- a spec with no Non-goals section;
- a Success criteria table row with no Baseline value;
- a `target` or `baseline` that does not resolve to a real commit.

These are **advisory** by default — recorded as findings, spec still
validates — and become **blocking** under `--strict-traceability`, which
fails validation on any of the above. A `legacy`-class document (no front
matter) is exempt from every check above; it is accepted and labeled, never
scored against these rules.
