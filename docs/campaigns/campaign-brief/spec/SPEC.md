---
id: campaign-brief
title: "Campaign Brief before execution"
version: 1.2.0
status: draft
date: 2026-09-22
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
spec and frozen plan that produced the execution contract. The plan remains
available for detail. Creating or viewing the brief never launches the contract.

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
  Campaign Brief before execution. Freeze records the structured spec's path
  and content digest with the plan; generation verifies that spec and the
  plan/contract digest pair before reading them. The Markdown names the
  campaign, spec baseline and digest, target git head, frozen plan path and
  contract digest. Missing inputs or a digest mismatch are refused, never
  summarized. The Markdown records the journal cursor and usage sample cutoff;
  the same spec, plan, contract and recorded-data snapshots produce the same
  bytes. Generation does not launch a run.
- **proof:** command: node --test test/campaign/campaign-brief.test.mjs

### R2. The first screen answers whether to proceed

- **statement:** the brief opens with one sentence of intent, expected outcome,
  measurable success criteria, and a decision state of `ready for human
  review` or `gaps to resolve`. The opening section before the coverage matrix
  has at most 250 words. It links to the technical plan, marks human-authored
  facts separately from calculated facts, and names missing source facts as
  gaps rather than inventing prose. Neither state approves execution.
- **proof:** command: node --test test/report/campaign-brief.test.mjs

### R3. Coverage is complete and traceable

- **statement:** a matrix lists every stable requirement id from the structured
  spec, the frozen contract nodes carrying that id, and each node's declared
  proof or verification. It cross-checks the frozen plan's phase declarations
  against those node ids and links to the spec and plan. A declared requirement
  with no responsible node is `uncovered`; absent phase declarations are a
  distinct `traceability missing` gap, not evidence that every requirement was
  intentionally left uncovered. Unknown ids in either phases or nodes are
  named explicitly.
- **proof:** command: node --test test/campaign/campaign-brief.test.mjs

### R4. The work and judgment are legible

- **statement:** the brief shows the actual `dependsOn` graph, its blocking
  prerequisites and dependency-independent nodes. It shows the contract's
  `maxParallel` and per-runtime `maxConcurrent` limits, distinguishing
  dependency-independent nodes from workers that can actually dispatch
  together. Human decisions and delegated decisions come
  from the explicit spec sections and active campaign journal decisions;
  risks and planned evals come only from this campaign's spec. Missing sections
  or conflicting decisions are gaps, not facts inferred from the graph.
- **proof:** command: node --test test/report/campaign-brief.test.mjs

### R5. Expense is a range with provenance

- **statement:** the brief states node and worker counts, assigned runtimes and
  models, effective worker concurrency, plus cost and elapsed-duration ranges
  derived from recorded usage, measured verification durations preserved with
  the frozen plan, and the dependency graph under the contract's capacity
  limits. A range requires at least five completed comparable samples for each
  assigned runtime and role; cost samples must be priced, and duration also
  requires a recorded measurement for every verification command. Comparable
  means the same runtime id, model and worker/judge role. The brief names the
  sample counts, source runs, method and assumptions. A timeout is not a
  duration measurement. If either measure lacks its required evidence, that
  measure says `insufficient data` instead of zero or a certain point estimate.
  Ranges are advisory, never spend or time ceilings.
- **proof:** command: node --test test/report/campaign-brief-estimate.test.mjs

### R6. Markdown renders as a portable Faberun document

- **statement:** Markdown is the source and `mdhtml` builds a self-contained
  `campaign-brief.md.html` copy that can be opened without Faberun, a server, or
  a network request. The theme uses the meanings, palette, contrast and system
  typography in `DESIGN.md`; source and rendered copy contain the same review
  facts. Rendering uses the external `mdhtml` CLI, version 1.1.3 or later in
  major version 1. The development/CI setup installs the pinned v1.1.3 release
  from `feliperun/md.html` and verifies its checksum; Faberun has no runtime
  dependency on it. An absent, incompatible or failing renderer is a named
  rendering failure: Markdown stays usable, and no partial HTML is exposed.
  Unit tests use a controlled executable fixture for success and failure; they
  do not skip when the real binary is absent. CI also runs an integration eval
  with the pinned release.
- **proof:** command: node --test test/report/campaign-brief-render.test.mjs

### R7. The brief is shareable without changing the plan

- **statement:** for each frozen phase plan, Faberun writes
  `<campaignDir>/plans/<phase>/campaign-brief.md` and, after a successful render
  and check, its sibling `campaign-brief.md.html`. The CLI prints their
  absolute paths so an operator can copy the portable HTML file. When `mdhtml`
  is unavailable, it prints the Markdown path and the rendering error; it
  never advertises absent or partial HTML. Rebuilding may update these two
  artefacts from the same pinned plan and recorded evidence, but never edits
  the spec, plan, contract, `operator-brief.md`, or an external service.
- **proof:** command: node --test test/cli/campaign-brief.test.mjs

### R8. A minimal local server opens the brief in a browser

- **statement:** the operator selects a frozen phase plan and starts a separate
  minimal local HTTP server, not the existing dashboard, receiving one browser
  URL for its generated HTML. The server binds only to loopback, serves that
  phase's current `campaign-brief.md.html` as `text/html; charset=utf-8` and
  exact read-only `/plan.json` and `/spec.md` drill-down routes for that plan
  and pinned spec. It refuses every unrelated path and a missing HTML copy
  with a named error, and
  releases its port on shutdown. It has no write route. The HTML file remains
  readable without the server; its review facts do not depend on the links.
- **proof:** command: node --test test/web/campaign-brief-server.test.mjs

## Non-goals

- Executing or approving the frozen contract when the brief is generated.
- Replacing the technical plan, changing contract semantics, or changing the
  existing `operator-brief.md` continuity capsule.
- A remotely accessible dashboard, automatic PR comments, or a publication
  service.
- Intent evaluation of the finished campaign (P2 on the roadmap).
- Editing historical campaign records or golden fixtures.

## Constraints

- Use the pinned spec, frozen plan and contract, campaign journal projection,
  and usage records as sources. Record the journal cursor and usage cutoff
  used to make each copy; never present a live value as a frozen plan fact.
- Keep `mdhtml` optional to the Faberun runtime: the current package has no
  runtime dependencies. Provision the versioned external release in CI, not
  the unrelated `mdhtml` package on npm. The Markdown remains usable when the
  renderer is unavailable.
- Preserve the source-tree boundaries in `AGENTS.md`: planning inputs in
  `plan/`, campaign state in `campaign/`, presentation in `report/` or `web/`,
  and argv in `cli/`.
- Each verification command in a Faberun packet must be measured before its
  timeout is set and must fit the 600-second command limit. Do not use an
  unpinned `--test-name-pattern` as proof. Run the full suite separately.
- No external publication or execution begins as a side effect of generating
  or viewing a brief.
- The local server binds to `127.0.0.1` or `::1` only and exposes no directory
  listing, arbitrary file path, or write route.

## Success criteria

| Measure | Baseline | Target | Evidence |
| --- | --- | --- | --- |
| Pre-execution approval artefact | none at `d9eae18` | Markdown for one frozen phase plan, plus portable HTML after a successful render | R1, R6, R7 |
| Requirement coverage visible before execution | ids on frozen nodes, no matrix | every spec requirement shown, including gaps | R3 |
| Execution graph and human decisions on one review surface | separate spec and plan | accurate graph and separated decisions | R4 |
| Cost and duration uncertainty exposed | usage and sizing facts exist, no brief range | sourced ranges with the five-sample rule, or an explicit insufficient-data state per measure | R5 |
| External writes caused by viewing the brief | no brief exists | zero | R1, R7 |
| Local browser access | no Campaign Brief browser surface at `d9eae18` | one loopback URL opens the selected phase's generated HTML | R8 |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A plausible summary disagrees with the frozen contract or spec | an operator approves different work | pin the spec and derive ids, edges and proofs from the validated frozen files; refuse digest mismatch |
| Sparse usage makes a cost range falsely precise | a misleading go/no-go decision | expose sample size, assumptions and an insufficient-data state |
| Styled HTML hides missing coverage or inaccessible colors | gaps are missed | keep semantic labels in text, test source/rendered content, follow `DESIGN.md` contrast roles |
| New approval brief is confused with the continuity capsule | a fresh seat loses operational facts | keep distinct names and paths; leave `operator-brief.md` unchanged |

## Settled owner decisions

- `operator-brief.md` remains the running-campaign continuity capsule;
  `campaign-brief.md` is the pre-execution approval source.
- The first sharing surface is a portable `mdhtml` file plus a minimal local
  web server that opens it in the browser. Remote publication and PR comments
  are outside this campaign.
- Each frozen phase plan owns its brief beside `plan.json`; the browser surface
  is a separate loopback-only server with exact read-only drill-down routes.

## Human decisions

- Review the generated brief and its technical plan before executing the
  contract. A frozen plan is not approval to execute.

## Delegable decisions

- Pick module boundaries, verification commands and the graph of implementation
  nodes from this spec and the repository facts.
- Use the measured records to select an honest range method, subject to R5's
  comparable-sample rule.
- Choose the exact `mdhtml` containers and Faberun theme CSS needed to render
  the required facts accessibly.

## Planned evals

- A missing or changed spec, missing phase declarations, an uncovered
  requirement, an unknown id and a stale contract digest must produce their
  distinct refusal or gap states. A complete fixture links each requirement
  to a real node and declared proof.
- Parallel siblings and a blocked successor retain their edges in Markdown
  and HTML. With `maxParallel: 1`, the siblings are not described as
  simultaneously dispatchable; a per-runtime cap is also respected.
- Four comparable usage samples yield `insufficient data`; five priced and
  completed samples yield a bounded cost range with counts and assumptions.
  A missing verification measurement withholds the duration range, and a
  declared timeout never substitutes for that measurement.
- CI installs and checksum-verifies the pinned `mdhtml` release; `mdhtml build`,
  `mdhtml check`, and `mdhtml audit` pass on a generated example. The rendered
  file works from disk with the network disabled. A missing or failing binary
  leaves usable Markdown and no advertised HTML.
- Two frozen plans in one campaign yield separate brief paths. The local
  server opens the selected HTML, serves only its exact plan/spec drill-down
  routes, refuses unrelated paths, and returns the same HTML bytes as on disk.

## Campaign execution outline

1. Make a deterministic Markdown brief from a frozen plan, with the coverage
   matrix and accurate execution graph. This is already useful without HTML.
2. Add decisions, risks, evals and a measured estimate, then render and check
   a portable Faberun-themed HTML copy with `mdhtml`.
3. Expose both artefacts through the CLI and a minimal local server. Review the
   generated brief and contract together before any
   execution contract is registered for supervision.
