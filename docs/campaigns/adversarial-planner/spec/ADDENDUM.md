# Orchestrator addendum to the owner's proposal v1.0.0 (2026-09-17)

The proposal now states requirements (R1–R17) with ids and proofs and no
nodes or phases; deriving nodes is the orchestrator's job until the planner
exists. Facts checked against `main` before authoring:

- **`forbidSameVendorAsWorker` does not exist** as a gate field. The invariant
  is the contract validator's rule that a gated node's worker, its fallback
  chain and its judge carry different `vendor` labels. R10 is met through
  labels (`anthropic-sonnet` / `anthropic-opus` in this Anthropic-only loop).
- **`src/engine/bulk-read.mjs` exists**; its table shape is the model for the
  routing table (R8).
- **R4 conflicts with the record rule.** `docs/campaigns/` holds nine campaign
  directories, four of them from the intent-factory era; the repository rule
  says records under `docs/campaigns/` and `docs/history/` are never edited.
  Proposed reading: the validator has a `legacy` acceptance for pre-format
  documents (recognised by the absence of the structured front matter) and R4
  is proven on the specs written from this campaign on, plus a structured
  `SPEC.md` sibling generated next to each `PROPOSAL.md` without touching the
  originals.
- **R1 adds a file under `skills/faberun/references/`.** `test/docs/docs-diet.test.mjs`
  asserts that directory holds exactly the two foundation documents and the
  four reserved articles, and `SKILL.md` (the router, 1,024-byte ceiling) must
  link every reference. The node that adds `spec-format.md` raises both with
  the dated justification the ratchet requires; the reserved articles stay the
  orchestrator's.
- **`rate_limits` is not parsed by any adapter** (R16): the Claude Code stream
  may carry it, but `src/harnesses/claude/index.mjs` does not surface it; the
  adapter is in scope for that node.
- **Only the `deterministic` eval class exists.** The `--case D-plan-*` proofs
  (R13–R15) need new case directories under `evals/deterministic/`; the
  comparative arm and `--validate-planner-arm` (R17) are new `evals/run.mjs`
  surface (`evals/compare.mjs` exists to reuse). `evals/golden` is a record.
  The "session arm" for old campaigns has their contracts under
  `docs/campaigns/*/control/` but their run ledgers live in gitignored
  `.runs/`; the arm must work from what the records carry.
- **`src/plan/` is a new layer** and needs a row in the `AGENTS.md` layout
  table; `faberun spec validate` / scaffold and `faberun plan` extend the
  command surface, which the generated manual now follows automatically.
- **Sizing for the loop.** Seventeen requirements are two campaigns' worth of
  work under the one-contract-per-phase rule: first the spec format and the
  deterministic stages (R1–R4, R7, R8, R10, R11, R12), then the planning
  contract, `faberun plan`, the seat allowance and the comparative arm (R5,
  R6, R9, R13–R17). Landing the first half early also gives the second half a
  validated spec to consume.
