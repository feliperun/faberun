# Orchestrator addendum (2026-09-17)

`adversarial-planner` v1.1.0 is the second half of the owner's v1.0.0
proposal; the first half is `spec-format-and-planning-stages`. Facts checked
against `main`:

- **`forbidSameVendorAsWorker` never existed in code**: it appears only in the
  owner's archived `docs/history/TECH-SPEC-2026-09-09.md`. The real invariant
  is the contract validator's vendor-label rule (worker, its fallback chain and
  judge differ; `routing.assignments` persist cross-vendor judges). R10 was
  rewritten without naming a mechanism and moved to the first half.
- **`rate_limits` is not parsed by any adapter**; R16 now says so and the
  claude adapter is in that node's scope.
- **Only the `deterministic` eval class exists**; `--case D-plan-*`, the
  comparative arm and `--validate-planner-arm` are new `evals/run.mjs`
  surface (`evals/compare.mjs` exists to reuse); `evals/golden` is a record.
- **The session arm's baseline** is the structured `SPEC.md` siblings (R4)
  plus the ledgers preserved by R18 and by the 2026-09-17 manual copy
  (`docs/campaigns/<id>/ledger/`).
- `faberun plan` and the spec verbs extend the command surface; the generated
  manual follows automatically; `operations.md` sits at its byte ceiling and
  needs the dated ratchet raise from the node that documents the verbs.
