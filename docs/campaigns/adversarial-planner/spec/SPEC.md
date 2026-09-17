# Spec: adversarial-planner — planning outside the session, with budget, isolation and a verdict by measurement

Campaign `adversarial-planner` (2026-09-17), fourth of the owner's improvement
loop and the second half of the owner's planner proposal (PROPOSAL.md v1.1.0,
requirements R5, R6, R9, R13–R17; ADDENDUM.md carries the fact checks). It
consumes what `spec-format-and-planning-stages` landed: `validateSpec`,
`collectRepoFacts`, `resolveRuntimes`, `applySizingRules`, `freezePlan`, the
spec format and the preserved ledgers. Anthropic models only: worker
`claude-sonnet-5` (`anthropic-sonnet`), judge `claude-opus-5` (`anthropic-opus`);
controller is the installed `~/.faberun/current` CLI.

Target: `/Users/frb/dev/frb/skills`, main at the landing of
`spec-format-and-planning-stages` (f888e1e) or later.

## Decisions already made

- **The planning pipeline is three one-node runs, not one run with a file
  handoff.** A discovery packet writes no file and the worker result is a
  closed record, so the draft's plan travels in a new optional `output` field
  of the worker result (a bounded JSON object, discovery nodes only, validated
  by `src/contract/worker-result.mjs`), and `faberun plan` orchestrates
  `draft` → `review` → `revise` as successive runs of one discovery node each,
  every invocation an ordinary run invocation recorded in `usage.jsonl`
  (R5). Spec authoring and spec review are two more one-node discovery
  contracts built by the same template.
- **The reviewer's packet is built from three inputs only** (R6): the spec,
  `repo-facts.json` and the plan (or the spec under review). The template
  never carries the draft packet or the draft worker's transcript, and a test
  proves the review packet contains neither.
- **The model classifies, the table routes** (proposal R8, landed): the draft
  returns `taskKind` and `riskTier` per node and never a runtime;
  `faberun plan` resolves runtimes through `resolveRuntimes` with the
  operator's `--runtime-defaults` winning over the table (R9) and the
  resolution persisted in the frozen contract.
- **Contested is a terminal plan state** (R14): review rounds are bounded by
  `--review-rounds` (default 2); when the last review still carries a
  `critical` finding, `plan.json` records `status: "contested"` with the open
  findings, no `contract.json` is written, and the campaign gets an attention
  entry naming them.
- **Freezing never launches** (R13): `faberun plan` ends by writing
  `plan.json` and `contract.json` under `.runs/campaigns/<id>/plans/<phase>/`
  and stops. `--approve-below standard|high|none` (default `standard`) decides
  whether the plan is recorded `approved` or waits: when the highest
  `riskTier` in the plan exceeds the policy, the campaign gets an attention
  entry with `requiresUser: true` and `faberun campaign resolve` records the
  approval. Launching an approved contract stays the operator's or the chain's
  explicit act.
- **Planning survives the seat** (R15): `faberun plan --detach` runs the
  pipeline as a detached process the same way `run --detach` does, with a
  bootstrap record and a lock, so closing the control session changes
  nothing.
- **Seat allowance is measured, not inferred** (R16): the node first measures
  what the Claude Code stream actually carries (one trivial `--output-format
  stream-json --verbose` invocation, the field names recorded in the module
  header); when a rate-limit signal exists the adapter surfaces it, the seat
  samples it at campaign start and at plan freeze and writes the delta as a
  `seat.allowance` journal event (declared in `docs/FIELD-OWNERSHIP.md` and
  `ENTRY_SHAPES`); when it does not exist the event records `null` and the
  header says so.
- **The verdict is a measurement** (R17): `evals/planner/` defines the
  comparative arm over the `REQUIREMENTS.md` siblings of at least eight real
  campaigns, the session side read from the preserved ledgers and campaign
  records; `evals/run.mjs --arm session|planner`, `--compare` with per-indicator
  sample counts, `--validate-planner-arm --min 8`; an indicator with no
  supporting record is `null`, never `0`. Running the planner arm live is an
  operator action with a cost; the campaign proves the arm on the session
  side and on recorded planner reports.
- The three `D-plan` proofs are deterministic eval cases in the repository's
  numbering (`D23` no-autostart, `D24` contested, `D25` detached) on the
  replay harness. Records, golden fixtures and reserved articles are never
  edited. `CONTRACT_VERSION` stays `0.3.0`.

## Non-goals

Replacing session authoring (it stays the documented fallback); a conversation
loop between author and reviewer; planning a whole campaign at once; changing
the operator's invocation; the evidence layer and mutation testing; running
the live planner arm inside this campaign.

## Phase 1 — planning pipeline (`adversarial-planner-1-planning-pipeline`)

1. **discovery-result-output.** 2. **planning-contract-template** (after 1).
3. **plan-verb** (after 2). 4. **plan-eval-cases** (after 3).

## Phase 2 — evidence (`adversarial-planner-2-evidence`)

1. **seat-allowance-delta.** 2. **planner-comparative-arm.**

## After the campaign (orchestrator)

Land on main, full suite, push, release, `faberun update`, run `faberun plan`
once for real against a spec of the next campaign and record the comparison,
retrospective, close.
