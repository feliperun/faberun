---
id: campaign-brief
title: "Campaign Brief before execution"
version: 1.0.0
status: draft
date: 2026-09-21
owner: Felipe Broering
target: feliperun/faberun
baseline: d9eae18a917d328326a3a07bdd80d34c379901cc
---

# Campaign Brief before execution

## Intent

An operator should be able to decide in a few minutes whether a frozen Faberun
plan is worth executing. Today the spec and technical plan contain the facts,
but there is no short review surface joining intent, coverage, work, evidence,
human decisions, risk, and expected expense. Generate a Campaign Brief from the
same frozen inputs the execution contract will use. The plan remains available
for detail. Creating or viewing the brief never launches the contract.

Measured at `d9eae18`: `src/plan/freeze.mjs` records a plan and validated
contract, requirement ids reach contract nodes, `dependsOn` defines the graph,
`src/plan/sizing.mjs` already estimates 14.5 minutes of non-worker overhead per
node from 100 recorded worker nodes, and `usage.jsonl` records priced invocation
costs. There is no pre-execution Campaign Brief. The existing
`operator-brief.md` is a separate, 4 KiB continuity capsule for a running
campaign and must retain that purpose.

## Requirements

### R1. One brief belongs to one frozen plan

- **statement:** after a plan freezes, the operator can generate and read its
  Campaign Brief before execution. The Markdown source names the campaign,
  spec baseline, target git head, frozen plan and contract digest; a changed or
  missing plan/contract is refused rather than silently summarized. Generation
  is repeatable from the same inputs and does not launch a run.
- **proof:** command: node --test test/campaign/campaign-brief.test.mjs

### R2. The first screen answers whether to proceed

- **statement:** the brief opens with one sentence of intent, expected outcome,
  measurable success criteria, and a clear decision state. It is short enough
  to scan before drilling into the linked technical plan; missing source facts
  appear as explicit gaps rather than invented prose.
- **proof:** command: node --test test/report/campaign-brief.test.mjs

### R3. Coverage is complete and traceable

- **statement:** a matrix lists every stable requirement id from the structured
  spec, the responsible frozen contract nodes, and each node's planned proof or
  verification. An uncovered requirement is visibly marked uncovered. A node
  that cites an unknown requirement id is identified. The matrix links back to
  the spec and plan.
- **proof:** command: node --test test/campaign/campaign-brief.test.mjs

### R4. The work and judgment are legible

- **statement:** the brief shows the actual `dependsOn` graph, including work
  that can run in parallel and the prerequisites that block each node. It
  separates decisions requiring human judgment from decisions delegated to
  Faberun, and shows only risks and planned evals relevant to this campaign.
  Unspecified human decisions, risks, or evals are called out as gaps, not
  inferred from the graph.
- **proof:** command: node --test test/report/campaign-brief.test.mjs

### R5. Expense is a range with provenance

- **statement:** the brief states node and worker counts, assigned runtimes and
  models, plus cost and elapsed-duration ranges derived from available recorded
  usage, measured verification times, and graph parallelism. It names the
  sample and assumptions. When data cannot support a range, it says
  "insufficient data" for that measure rather than displaying zero or a
  point estimate as certain. It is advisory, never a spend ceiling.
- **proof:** command: node --test test/report/campaign-brief-estimate.test.mjs

### R6. Markdown renders as a portable Faberun document

- **statement:** Markdown is the source and `mdhtml` builds a self-contained
  HTML copy that can be opened without Faberun or a network request. The theme
  uses the meanings, palette, contrast and typography in `DESIGN.md`; source
  and rendered copy contain the same review facts. A failed build or check is
  reported rather than publishing a partial copy.
- **proof:** command: node --test test/report/campaign-brief-render.test.mjs

### R7. The brief is shareable without changing the plan

- **statement:** Faberun exposes the source and portable HTML as durable
  campaign artefacts with an unambiguous path or link that an operator can
  share. Rebuilding the brief updates the artefacts from the frozen plan and
  never edits the plan, contract, `operator-brief.md`, or an external service.
- **proof:** command: node --test test/cli/campaign-brief.test.mjs

## Non-goals

- Executing or approving the frozen contract when the brief is generated.
- Replacing the technical plan, changing contract semantics, or changing the
  existing `operator-brief.md` continuity capsule.
- A hosted dashboard, automatic PR comments, or a new publication service.
- Intent evaluation of the finished campaign (P2 on the roadmap).
- Editing historical campaign records or golden fixtures.

## Constraints

- Use the existing spec, frozen plan, contract, campaign journal, and usage
  records as sources. The brief must say which facts are authored by a human
  and which are calculated from those sources.
- Keep `mdhtml` optional to the Faberun runtime: the current package has no
  runtime dependencies. The Markdown remains usable when the renderer is
  unavailable.
- Preserve the source-tree boundaries in `AGENTS.md`: planning inputs in
  `plan/`, campaign state in `campaign/`, presentation in `report/` or `web/`,
  and argv in `cli/`.
- Each verification command in a Faberun packet must be measured before its
  timeout is set and must fit the 600-second command limit. Do not use an
  unpinned `--test-name-pattern` as proof. Run the full suite separately.
- No external publication or execution begins as a side effect of generating
  or viewing a brief.

## Success criteria

| Measure | Baseline | Target | Evidence |
| --- | --- | --- | --- |
| Pre-execution approval artefact | none at `d9eae18` | Markdown and portable HTML for a frozen plan | R1, R6 |
| Requirement coverage visible before execution | ids on frozen nodes, no matrix | every spec requirement shown, including gaps | R3 |
| Execution graph and human decisions on one review surface | separate spec and plan | accurate graph and separated decisions | R4 |
| Cost and duration uncertainty exposed | usage and sizing facts exist, no brief range | sourced ranges or explicit insufficient-data state | R5 |
| External writes caused by viewing the brief | no brief exists | zero | R1, R7 |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A plausible summary disagrees with the frozen contract | an operator approves different work | derive ids, edges and proofs from the validated frozen files; refuse digest mismatch |
| Sparse usage makes a cost range falsely precise | a misleading go/no-go decision | expose sample size, assumptions and an insufficient-data state |
| Styled HTML hides missing coverage or inaccessible colors | gaps are missed | keep semantic labels in text, test source/rendered content, follow `DESIGN.md` contrast roles |
| New approval brief is confused with the continuity capsule | a fresh seat loses operational facts | keep distinct names and paths; leave `operator-brief.md` unchanged |

## Human decisions

- Confirm the name of the approval artefact. The proposed answer to roadmap
  Q2 is `campaign-brief.md`, distinct from `operator-brief.md`.
- Choose the first sharing surface. The proposed first release exposes a local,
  portable HTML file and its Markdown source; a public URL or PR comment needs
  a separate, explicit publication action.
- Review the generated brief and its technical plan before executing the
  contract. A frozen plan is not approval to execute.

## Delegable decisions

- Pick module boundaries, verification commands and the graph of implementation
  nodes from this spec and the repository facts.
- Use the measured records to select an honest estimate method and withhold a
  range when its sample is inadequate.
- Choose the exact `mdhtml` containers and Faberun theme CSS needed to render
  the required facts accessibly.

## Planned evals

- A fixture with a missing requirement and a stale contract digest must expose
  both defects; a complete fixture must link each requirement to a real node
  and declared proof.
- A graph fixture with parallel siblings and a blocked successor must preserve
  those edges in Markdown and HTML.
- A sparse usage fixture must show "insufficient data"; a recorded sample must
  yield a bounded range with its sample count and assumptions.
- `mdhtml build`, `mdhtml check`, and `mdhtml audit` must pass on the generated
  example, and the rendered file must work from disk with the network disabled.

## Campaign execution outline

1. Make a deterministic Markdown brief from a frozen plan, with the coverage
   matrix and accurate execution graph. This is already useful without HTML.
2. Add decisions, risks, evals and a measured estimate, then render and check
   a portable Faberun-themed HTML copy with `mdhtml`.
3. Expose both artefacts through the CLI and existing read-only campaign
   surface. Review the generated brief and contract together before any
   execution contract is registered for supervision.

The roadmap's Q2 naming choice and the first sharing surface remain owner
decisions until recorded in the campaign journal. The proposed names are
`operator-brief.md` for continuity and `campaign-brief.md` for approval.
