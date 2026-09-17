# Orchestrator addendum (2026-09-17)

First half of the owner's `adversarial-planner` v1.0.0, split on 2026-09-17
with the five corrections agreed that night (R4 legacy class, R1 ratchets, R10
without a named mechanism, R18 ledger preservation, the split itself). This
campaign runs after `env-independence-and-generated-docs` lands. Authoring
notes:

- `src/plan/` is a new layer: the node that creates it adds the row to the
  layout table in `AGENTS.md`.
- R1's new reference raises three ratchets in `test/docs/docs-diet.test.mjs`
  (references byte ceiling, the "exactly these documents" assertion, the
  1,024-byte `SKILL.md` router), each with the dated justification.
- R4's structured `SPEC.md` siblings are new files next to each existing
  `PROPOSAL.md`; originals and `docs/history/` are never edited.
- R18 lands first. On 2026-09-17 the orchestrator copied by hand every ledger
  still present under `.runs/` (journals, `usage.jsonl` per run, `campaign.json`)
  into `docs/campaigns/<id>/ledger/` for 21 campaigns, so the comparative arm's
  session side starts with what survived; the command makes it automatic.
- Anthropic-only runtimes with vendor labels `anthropic-sonnet` / `anthropic-opus`.
