# Spec: spec-format-and-planning-stages — a validated spec format, the planner's deterministic stages, and ledgers that outlive their campaign

Campaign `spec-format-and-planning-stages` (2026-09-17), third of the owner's
improvement loop and the first half of the owner's planner proposal
(PROPOSAL.md v1.1.0, requirements R1–R4, R7, R8, R10–R12, R18; ADDENDUM.md
carries the fact checks). Anthropic models only: worker `claude-sonnet-5`
(`anthropic-sonnet`), judge `claude-opus-5` (`anthropic-opus`), no fallback;
controller is the installed `~/.faberun/current` CLI.

Target: `/Users/frb/dev/frb/skills`, main at the landing of
`env-independence-and-generated-docs` (5857b44) or later.

## Decisions already made

- **Everything here runs without a model.** The spec validator, the repository
  inventory, the routing table, the sizing rules and the freeze are pure
  functions over files and git; each is proven against fixtures. They are the
  safety net for the model-invoking nodes of `adversarial-planner`.
- **R18 lands first.** `campaign close` copies the campaign's `journal.jsonl`
  and `campaign.json` and every linked run's `usage.jsonl` into
  `docs/campaigns/<id>/ledger/`, idempotently. No redactor exists in this tree
  (the proposal's "capsule redactor" is elsewhere); the ledgers carry token
  counts, costs and operator notes, and the pre-commit secret scan stays the
  guard. The orchestrator already copied 21 campaigns' ledgers by hand on
  2026-09-17.
- **The spec format** is a markdown document with structured front matter
  (`id`, `title`, `version`, `status`, `date`, `owner`, `target`, `baseline`)
  and mandatory sections Intent, Requirements and Non-goals; a requirement is
  `### R<n>. <title>` with a `statement` and a `proof` (`command:`, `path:` or
  `judgment: true`); Constraints, Success criteria (a table with a Baseline
  column) and Risks are optional. It is documented as a worker-loadable
  reference, `skills/faberun/references/spec-format.md`, which raises three
  dated ratchets: its own byte ceiling in `test/docs/docs-diet.test.mjs`, the
  assertion that names every file under `references/`, and the 1,024-byte
  `SKILL.md` router that must link it.
- **`faberun spec validate <file> [--strict-traceability] [--json]`** reports
  the document's class: `structured` (front matter present; rules applied,
  advisory unless `--strict-traceability`) or `legacy` (no front matter;
  accepted, said so). `faberun spec scaffold <path>` writes an empty document
  in the format. The rules: requirement without a stable id, requirement
  without proof, missing Non-goals, success criterion without baseline,
  `target`/`baseline` that does not resolve to a commit (bounded git through
  `src/repo/git.mjs`, never a raw spawn).
- **Records stay records.** Every campaign under `docs/campaigns/` gets a
  structured `spec/REQUIREMENTS.md` sibling derived from its existing
  documents; the originals and `docs/history/` are not touched. The
  "existing specs validate" test requires every `REQUIREMENTS.md` to validate
  strictly and every other spec document to be accepted as `legacy`.
- **Repository facts** (`collectRepoFacts`): tracked paths, declared scripts,
  candidate verification commands with duration measured through the
  existing `timeVerificationCommands`, test files with the module they cover
  by name, git HEAD; deterministic between two runs at the same HEAD; bounded;
  commands over 600 s marked ineligible.
- **Routing** (`resolveRuntimes`): a declarative table `{when: {taskKind,
  riskTier}, prefer: [runtimeId...]}` crossed with discovery's availability
  and exhaustion; precedence node override > operator `runtimeDefaults` >
  table > discovery; a judge never shares a vendor label with the worker or
  any runtime in its fallback chain; an unmet rule fails naming the rule.
- **Sizing** (`applySizingRules`): merge a node with no mechanical proof into
  its parent; merge a node whose writeFiles sit inside another's and has no
  verification of its own; split or narrow a verification whose measured
  duration exceeds the node's budget; mark dependency-free nodes with disjoint
  writeFiles parallelisable; refuse a one-node contract unless flagged as a
  targeted fix; require a justification for a serial chain deeper than eight.
  Idempotent; every transformation records the rule that caused it.
- **Freeze** (`freezePlan`): `plan.json` and `contract.json` with the
  contract digest (`contractDigest`), a provenance block (package version,
  schemaVersion, target git HEAD, the planner/reviewer runtime pair, sizing
  rules applied, reviewer findings with severity); tampering with a byte
  invalidates the digest; the emitted contract passes `validateContract`.
- **`src/plan/` is a new layer** and gains its row in the `AGENTS.md` layout
  table. Historical documents, golden fixtures and campaign records are never
  edited. `CONTRACT_VERSION` stays `0.3.0`. The reserved articles,
  `contract.md` and `operations.md` are not touched by any node.

## Non-goals

Any model-invoking node (spec authoring/review, the planning contract,
`faberun plan`, the comparative arm, the seat allowance): they are
`adversarial-planner` v1.1.0. Rewriting any record. Changing existing verbs.

## Phase 1 — ledger and spec format (`spec-format-and-planning-stages-1-ledger-and-spec-format`)

1. **campaign-close-preserves-ledger** (R18). 2. **spec-format-reference**
(R1). 3. **spec-validate** (R2, R3, legacy class of R4; the `spec` verb; the
`plan/` layout row). 4. **structured-spec-siblings** (R4, after 3).

## Phase 2 — planning stages (`spec-format-and-planning-stages-2-planning-stages`)

1. **repo-facts** (R7). 2. **routing-table** (R8, R10). 3. **sizing-rules**
(R11). 4. **plan-freeze** (R12).

## After the campaign (orchestrator)

Land on main, full suite, push, release, `faberun update`, retrospective,
close (the first close that preserves its own ledger); then author
`adversarial-planner` v1.1.0.
