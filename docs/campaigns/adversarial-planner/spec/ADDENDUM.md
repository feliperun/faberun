# Orchestrator addendum to the owner's proposal (2026-09-17)

Queued as the third campaign of the improvement loop, after
`env-independence-and-generated-docs` (its N5 supplies `declaredReadBytes`).
Facts checked against `main` at ee54a83 before authoring:

- **`forbidSameVendorAsWorker` does not exist.** No gate field carries that
  name; the invariant lives in the contract validator, which refuses a gated
  node whose worker and judge share `vendor` (and the worker's fallback chain).
  N2 and N6 reuse that rule through vendor labels; the routing table must
  resolve a judge whose label differs from the worker's, not set a flag.
- **`rate_limits` is not parsed by any adapter.** The Claude Code stream may
  carry it, but `src/harnesses/claude/index.mjs` does not surface it. N9 has to
  add the parsing to the adapter (or the seat's harness probe) before it can
  sample a delta; the packet must include the adapter in `writeFiles`.
- **Only the `deterministic` eval class exists.** `--class stochastic`,
  `--arm` and `--compare` are new surface for `evals/run.mjs` (an
  `evals/compare.mjs` module exists and should be reused or extended).
  `--case D-plan-*` ids need new case directories under `evals/deterministic/`
  and the golden set; `evals/golden` itself is a record and is not edited.
- **ADR numbering.** `docs/adr/` holds 0001–0006; the proposal's ADR-0038…0042
  become 0007–0011 in the repository's sequence.
- **`src/plan/` is a new layer.** The layout table in `AGENTS.md` names every
  layer; the node that creates the directory adds the row (`plan/` — the
  out-of-session planner: repo facts, routing, sizing, freeze).
- **Reserved articles and `contract.md`/`operations.md` ceilings.** N2, N5 and
  N7 write `references/contract.md` and `operations.md`, both at their byte
  ceilings; those nodes must raise the ceiling in `test/docs/docs-diet.test.mjs`
  with the dated justification the ratchet requires, and the reserved articles
  (`rules.md`, `engineering.md`, `workflow.md`, `handoffs.md`) stay the
  orchestrator's.
- **Anthropic-only judging** uses the independence labels `anthropic-sonnet` /
  `anthropic-opus`; the routing table's `prefer` lists in the proposal name
  runtimes of other vendors (zcode, flash, luna) and will be authored against
  the runtimes the loop actually has.
