# campaign spec-format-and-planning-stages handoff

Updated: 2026-09-17T06:24:10.565Z

## Goal

First half of the owner's planner proposal: campaign close preserves its ledgers in the record; a versioned, validated spec format documented as a worker-loadable reference with faberun spec validate and scaffold (deterministic, legacy class for pre-format documents) and a structured REQUIREMENTS.md beside every campaign record; and the planner's four deterministic stages under src/plan/ -- repository facts with measured durations, a declarative routing table with vendor independence, sizing rules with provenance, and a freeze with digest and provenance -- each proven against fixtures without a model. Anthropic models only. Spec: docs/campaigns/spec-format-and-planning-stages/spec/SPEC.md.

## Latest next action

None.

## Session lineage

None.

## Active decisions

None.

## User constraints

None.

## Open questions

None.

## Linked runs

- spec-format-and-planning-stages-1-ledger-and-spec-format: 4 nodes · 4 done
- spec-format-and-planning-stages-2-planning-stages: 4 nodes · 4 done

## Recent user intents

None.

## Attempts and outcomes

- run spec-format-and-planning-stages-1-ledger-and-spec-format: Run 1 (ledger-and-spec-format) done under the chain: campaign close preserves ledgers (preserveCampaignLedger), references/spec-format.md with the three ratchets raised, faberun spec validate/scaffold on src/plan/spec.mjs (deterministic, legacy class) with the plan/ layer row in AGENTS.md, and a strict-valid REQUIREMENTS.md beside every campaign record (10 documents, 69 proofs); the judge sent the siblings node back once for two --test-name-pattern proofs that matched no real title (node --test exits 0 on an empty selection), fixed in attempt 2. Every integrated candidate verified with the full suite; promoted; contract 2 launched by the coordinator. USD 13.89. · claude-control-spec-format · 2026-09-17T04:26:11.936Z
- run spec-format-and-planning-stages-2-planning-stages: Run 2 (planning-stages) done under the chain: collectRepoFacts (deterministic, measured durations, eligibility), resolveRuntimes (table, precedence, exhaustion, vendor labels), applySizingRules (six rules with provenance, idempotent; the judge found a defect under one rule on attempt 1, fixed in attempt 2) and freezePlan/verifyFrozenPlan (digest + provenance, tamper detection, emitted contract validates); routing-table's attempt 1 tripped the duplicate-body ratchet by copying two helpers from runtime-discovery and imported them in attempt 2. Every candidate verified with the full suite; promoted; the coordinator reported the campaign done. USD 7.79. · claude-control-spec-format · 2026-09-17T06:22:41.227Z
- Campaign spec-format-and-planning-stages, 2026-09-17 03:12 UTC to about 06:35 UTC (3.4 h): third campaign of the improvement loop, first half of the owner's planner proposal (PROPOSAL.md v1.1.0 R1-R4, R7, R8, R10-R12, R18), Anthropic models only (claude-sonnet-5 workers USD 16.51, claude-opus-5 judge USD 5.17, USD 21.67 in all), driven by supervise campaign from the installed 0.7.0 CLI in two runs over 8 node instances, 11 attempts and 21 provider invocations. Landed on main by a --no-ff merge (f888e1e, the feat commit) with the full suite green. Delivered, each node's integrated candidate verified with the whole suite: campaign close preserves the campaign's journal, campaign.json and every linked run's usage.jsonl into docs/campaigns/<id>/ledger/ (preserveCampaignLedger; this campaign's own close is the first automatic use); skills/faberun/references/spec-format.md documents the spec format and SKILL.md routes to it, the three documentation ratchets raised with dated reasons; src/plan/spec.mjs validates a spec without a model (structured or legacy, advisory or --strict-traceability) behind faberun spec validate and faberun spec scaffold, and src/plan/ joined the AGENTS.md layout table; every campaign record gained a strict-valid spec/REQUIREMENTS.md sibling (10 documents, 69 proofs, originals untouched); the planner's four deterministic stages -- collectRepoFacts (measured durations, eligibility, byte-identical between runs), resolveRuntimes (table, precedence, exhaustion, vendor labels), applySizingRules (six rules, provenance, idempotent) and freezePlan/verifyFrozenPlan (contract digest, provenance block, tamper detection, validator-accepted contract). What the gate taught: the judge sent two nodes back for real defects the deterministic checks could not see -- two --test-name-pattern proofs matching no real title (node --test exits 0 on an empty selection) and a wrong implementation under one sizing rule with discriminating tests around it -- and sharedVerification caught a copied helper pair (duplicate-b… · claude-control-spec-format · 2026-09-17T06:24:10.565Z

