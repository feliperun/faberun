---
id: campaign-brief
title: "Campaign Brief before execution"
version: 1.4.0
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
  and content digest in `plan.json`. The planning pipeline writes the final
  `plan.json`, including its `status` and `approved` fields, before writing
  `plan.json.sha256` over those exact final bytes; it never rewrites the plan
  after the sidecar. Generation verifies the whole plan file against that
  independent digest, then verifies the contract and spec digests before
  reading facts. The Markdown names the campaign, spec baseline and digest,
  target git head, frozen plan path and contract digest. Missing
  inputs or a mismatch are refused, never summarized. Plans frozen before
  these identity fields exist require refreezing. The Markdown records the
  journal cursor and usage sample cutoff; the same spec, plan, contract and
  recorded-data snapshots produce the same bytes. Neither freezing nor
  generation launches a run.
- **proof:** command: node --test test/plan/freeze.test.mjs test/plan/pipeline.test.mjs test/campaign/campaign-brief.test.mjs

### R2. The first screen answers whether to proceed

- **statement:** the brief opens with one sentence of intent, expected outcome,
  measurable success criteria, and a decision state of `ready for human
  review` or `gaps to resolve`. The opening section before the coverage matrix
  has at most 250 words. It links to the technical plan, marks human-authored
  facts separately from calculated facts, and names missing source facts as
  gaps rather than inventing prose. `gaps to resolve` applies whenever R3 or
  R4 reports a gap or R5 reports `insufficient data`;
  otherwise the state is `ready for human review`. Neither state approves
  execution.
- **proof:** command: node --test test/report/campaign-brief.test.mjs

### R3. Coverage is complete and traceable

- **statement:** a matrix lists every stable requirement id from the structured
  spec, the frozen contract nodes carrying that id, and each node's declared
  proof or verification. The planner gives every planned node one internal
  phase id and declares each phase's requirement ids and deliverable; these
  internal ids are distinct from the CLI `--phase` name of the frozen artefact.
  The planning pipeline passes both node phase ids and declarations to freeze,
  which stamps the phase's requirement ids on its contract nodes and records
  the declarations in `plan.json`. A missing or undeclared node phase is a
  planning error, not a silently unattributed node. The brief cross-checks
  the frozen declarations against the stamped node ids and links to the spec
  and plan. A declared requirement with no responsible node is `uncovered`;
  absent phase declarations are a
  distinct `traceability missing` gap, not evidence that every requirement was
  intentionally left uncovered. A phase declaration that maps to no frozen
  node is also `traceability missing`, so a real planner/freeze fixture must
  preserve the phase-to-node mapping. Unknown ids in either phases or nodes
  are named explicitly.
- **proof:** command: node --test test/plan/template.test.mjs test/plan/pipeline.test.mjs test/plan/freeze.test.mjs test/campaign/campaign-brief.test.mjs

### R4. The work and judgment are legible

- **statement:** the brief shows the actual `dependsOn` graph, its blocking
  prerequisites and dependency-independent nodes. It shows the contract's
  `maxParallel` and per-runtime `maxConcurrent` limits, distinguishing
  dependency-independent nodes from workers that can actually dispatch
  together. Human decisions and delegated decisions come from the explicit
  spec sections and active campaign journal decisions;
  risks and planned evals come only from this campaign's spec. Missing sections
  or conflicting decisions are gaps, not facts inferred from the graph.
- **proof:** command: node --test test/report/campaign-brief.test.mjs

### R5. Expense is a range with provenance

- **statement:** the brief states node and worker counts, assigned runtimes and
  models, effective worker concurrency, plus cost and elapsed-duration ranges
  derived from prior completed execution nodes, their priced `usage.jsonl`
  invocations and recorded verification durations, and the dependency graph
  under the contract's capacity limits. The pool is this target project's
  durable runs completed in the 90 days before the recorded usage cutoff;
  planning/discovery runs and incomplete nodes are excluded. Comparable nodes
  have the same task kind, runtime id, model and worker/judge role. A range
  requires at least five distinct comparable completed nodes for every
  assigned role; cost also requires priced usage, and duration requires
  recorded actual node and verification elapsed times. The estimate uses these
  historical timings as proxies for planned commands that have not run yet;
  it never uses `timeoutSec` as a measurement. The brief names source runs,
  sample counts, dates, cost provenance, method and assumptions. If the pool
  is unreadable or either measure lacks its required evidence, that measure
  says `insufficient data` with the reason, not zero or a certain point
  estimate. Ranges are advisory, never spend or time ceilings.
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
  rendering failure: Markdown stays usable, and no partial or stale HTML is
  exposed. Unit tests use a controlled executable fixture for success and
  failure and never skip. The `check:campaign-brief-render` development/CI
  command provisions the checksum-verified release, runs those tests, then
  builds, checks and audits a real example and verifies its facts, theme and
  offline file opening.
- **proof:** command: npm run check:campaign-brief-render

### R7. The brief is shareable without changing the plan

- **statement:** after a plan freezes, the operator explicitly runs
  `faberun campaign brief generate <id> --phase <phase>`; freezing does not
  generate a brief. For that phase, Faberun writes
  `<campaignDir>/plans/<phase>/campaign-brief.md` and, after a successful render
  and check, its sibling `campaign-brief.md.html`. The CLI prints their
  absolute paths so an operator can copy the portable HTML file. When `mdhtml`
  is unavailable or rendering fails, it exits with a named error, prints the
  Markdown path, and removes any prior HTML copy for that phase so it cannot
  be mistaken for the current brief. Rebuilding may update these two
  artefacts from the pinned plan and recorded evidence, but never edits
  the spec, plan, contract, `operator-brief.md`, or an external service.
- **proof:** command: node --test test/cli/campaign-brief.test.mjs

### R8. A minimal local server opens the brief in a browser

- **statement:** the operator selects a frozen phase plan with
  `faberun campaign brief serve <id> --phase <phase>` and starts a separate
  minimal local HTTP server, not the existing dashboard. Before binding it
  verifies and holds that plan's pinned spec and plan bytes; missing or changed
  source files or a missing HTML copy make startup fail with a named error and
  no browser URL. On success the server binds only to loopback, serves that
  phase's current `campaign-brief.md.html` as `text/html; charset=utf-8` and
  exact read-only `/plan.json` and `/spec.md` drill-down routes from those
  verified bytes. It refuses every unrelated path, releases its port on
  shutdown and has no write route. The HTML file remains readable without
  the server; its review facts do not depend on the links.
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
| Cost and duration uncertainty exposed | usage and sizing facts exist, no brief range | ranges from comparable project execution records, or an explicit insufficient-data state per measure | R5 |
| External writes caused by viewing the brief | no brief exists | zero | R1, R7 |
| Local browser access | no Campaign Brief browser surface at `d9eae18` | one loopback URL opens the selected phase's generated HTML when it exists; no URL otherwise | R8 |

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

- A missing or changed spec, missing phase declarations, a phase with no
  frozen node, an uncovered requirement, an unknown id, a changed `plan.json`
  and a stale contract digest produce their distinct refusal or gap states. A
  real planner/freeze fixture assigns internal phases to nodes, preserves the
  phase declarations and links each requirement to a node and proof. It
  rejects a node with no declared phase and a sidecar made before the pipeline
  adds the plan's final status/approval fields;
  older frozen plans lacking spec identity are refused until refrozen.
- Parallel siblings and a blocked successor retain their edges in Markdown
  and HTML. With `maxParallel: 1`, the siblings are not described as
  simultaneously dispatchable; a per-runtime cap is also respected.
- Four comparable completed execution nodes in this project's 90-day window
  yield `insufficient data`; five with priced usage yield a cost range, and
  five with measured node and verification durations yield a duration range.
  Discovery nodes, samples outside the window, unreadable history and a
  declared timeout cannot fill a missing sample.
- The R6 proof command installs and checksum-verifies the pinned `mdhtml`
  release, then `mdhtml build`, `mdhtml check`, and `mdhtml audit` pass on a
  generated example. The rendered file works from disk with the network
  disabled and preserves source facts and the theme. A missing or failing
  binary leaves usable Markdown and removes any stale HTML.
- Two frozen plans in one campaign yield separate brief paths. The local
  server opens the selected HTML, serves only its pinned plan/spec drill-down
  routes, refuses unrelated paths, and returns the same HTML bytes as on disk.
  With no HTML or a changed spec, startup fails and prints no URL.
- Freezing a plan writes no brief; only the explicit `generate` verb creates
  one. Rebuilding after a successful render and then failing `mdhtml` removes
  the previous HTML so neither the CLI nor server can present a stale copy.

## Campaign execution outline

1. Make a deterministic Markdown brief from a frozen plan, with the coverage
   matrix and accurate execution graph. This is already useful without HTML.
2. Add decisions, risks, evals and a measured estimate, then render and check
   a portable Faberun-themed HTML copy with `mdhtml`.
3. Expose both artefacts through the CLI and a minimal local server. Review the
   generated brief and contract together before any
   execution contract is registered for supervision.
