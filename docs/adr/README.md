# Architecture Decision Records

Architecture Decision Records (ADRs) for **Faberun**.

## Format

Each ADR is markdown with YAML frontmatter:

```markdown
---
type: ADR
id: "0001"
title: "Short decision title"
status: proposed        # proposed | active | superseded | retired
date: YYYY-MM-DD
superseded_by: "0007"  # only if status: superseded
---

## Context
...

## Decision
**What was decided.**

## Options considered
...

## Consequences
...
```

### Status lifecycle

```
proposed → active → superseded
                 ↘ retired
```

## Rules

- One decision per file.
- Files named `NNNN-short-title.md` (monotonic numbering).
- Once `active`, never edit — supersede instead.
- [../ARCHITECTURE.md](../ARCHITECTURE.md) reflects active decisions only.
- Each ADR cites the section of the
  [become-faberun spec](../campaigns/become-faberun/spec/SPEC.md) and the
  reference it comes from.

## Index

| ID | Title | Status |
|----|-------|--------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | active |
| [0002](0002-root-managed-ai-guidance.md) | Root-managed AI guidance files | active |
| [0003](0003-harness-and-model-agnostic-orchestration.md) | Harness- and model-agnostic orchestration | active |
| [0004](0004-closed-task-packets-and-cross-vendor-judges.md) | Closed task packets with mechanical proof and cross-vendor judges | active |
| [0005](0005-repository-becomes-the-faberun-cli.md) | The repository becomes the Faberun CLI | active |
| [0006](0006-github-releases-distribution-and-self-update.md) | GitHub Releases and npm distribution with install.sh and self-update | active |
| [0007](0007-windows-install-and-directory-links.md) | Windows install: one layout, junctions for directory links | active |

This repository does not adopt Sentrux; its structural quality gate is
[`test/repo/source-shape.test.mjs`](../../test/repo/source-shape.test.mjs),
described in [../ARCHITECTURE.md](../ARCHITECTURE.md).
