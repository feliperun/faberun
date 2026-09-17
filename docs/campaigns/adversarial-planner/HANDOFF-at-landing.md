# campaign adversarial-planner handoff

Updated: 2026-09-17T14:34:52.805Z

## Goal

Second half of the owner's planner proposal: planning outside the session. A discovery result may carry a bounded structured output; one template builds the one-node discovery contracts for draft, review, revise, spec authoring and spec review with the reviewer isolated to spec, facts and artefact; faberun plan orchestrates them into a frozen plan that never launches and can end contested, with the operator's runtime defaults winning and approval by risk policy through the campaign's open-question; three deterministic eval cases prove no-autostart, contested and detached; the seat's allowance is measured and journaled where the harness exposes it; a comparative eval arm decides by measurement whether the planner beats session authoring. Anthropic models only. Spec: docs/campaigns/adversarial-planner/spec/SPEC.md.

## Latest next action

None.

## Session lineage

None.

## Active decisions

- [discovery-output-scope] discovery-result-output attempt 1 passed verification but the judge found the mode flag threaded only into parseDiscoveryResult while every real ingestion path (resolveWorkerResult, canonical reload, resume, snapshot validator, judge prompt) still rejected or dropped output; attempt 2 blocked with context_missing because those modules were outside the packet -- an orchestrator omission of the ingestion paths. Contract 1 replaced by 1b: same four nodes, the first (discovery-output-ingested) with the complete write set and a design that accepts the field at the schema level and refuses it for execution nodes at the one mode-aware ingestion point. · claude-control-adversarial-planner · 2026-09-17T07:05:26.661Z
- [allowance-window-writers] Contract 2b's node delivered the window extraction, the cross-window guard and the adapter-built probe argv, and the judge blocked it because the two writers of seat.allowance (campaign init's start sample, plan freeze's freeze sample) still emitted the old field set, so the new guard would kill every delta in production; those call sites were outside the packet (my omission, excluded on purpose because the previous node had landed them). Work landed on the campaign branch (d5840a1) and superseded by contract 2c, which has both writers in scope and asks for one helper to own the event fields. · claude-control-adversarial-planner · 2026-09-17T14:04:45.969Z

## User constraints

- Engine defect: supervise campaign validates a manifest entry in a worktree of the land branch, but the detached run it launches re-validates the contract against the checkout (src/cli.mjs validates before honouring --base-ref). Contract 1d reads src/cli/plan.mjs, which exists only on campaign/adversarial-planner, so the launch failed with 'detached bootstrap failed before readiness' and the campaign parked with launch_failed. Workaround applied: the checkout is detached at the land branch while the chain runs. Fix candidate recorded for the next campaign: run --base-ref validates against that ref. · claude-control-adversarial-planner · 2026-09-17T11:02:24.497Z

## Open questions

None.

## Linked runs

- adversarial-planner-1-planning-pipeline: 4 nodes · 4 blocked
  - discovery-result-output: blocked · The schema work in src/contract/worker-result.mjs is sound in isolation: `output` is optional, typed (`output?: JsonObject` on the WorkerResult typedef), validated with assertObject, bounded to 65536 bytes by JSON.stringify byte length, excluded from the 32 KiB envelope cap on purpose (with a com…
  - plan-eval-cases: blocked · blocked by plan-verb
  - plan-verb: blocked · blocked by planning-contract-template
  - planning-contract-template: blocked · blocked by discovery-result-output
- adversarial-planner-1b-discovery-result-output: 4 nodes · 3 done · 1 blocked
  - plan-eval-cases: blocked · src/cli/plan.mjs needs an override channel for the planning pipeline's `runtimes` catalogue (currently hardcoded to DISCOVERY_RUNTIME_DEFINITIONS, all real-provider harnesses) so a command-kind eval case can point it at `replay`-harness entries backed by the case's recording files -- add src/cli/…
- adversarial-planner-2-evidence: 2 nodes · 2 exhausted
  - planner-comparative-arm: exhausted · deterministic verification failed (unexpected paths changed (1): evals/planner/session-arm.json)
  - seat-allowance-delta: exhausted · Attempt 2 repairs all four attempt-1 findings, and I confirmed each against the tree: the `if (signal)` short-circuit is once again the first statement of normalizeClaudeResult (with a regression test replaying the truncated-tail kill directly), freeze now re-samples the harness recorded by init'…
- adversarial-planner-2b-allowance-window: 1 nodes · 1 blocked
  - allowance-window-pinned: blocked · Fail on [window-pinned]. Two of the four clauses hold in the write files: `extractClaudeAllowance` now returns `window` from `rateLimitType` and reads that window's `utilization`/`resetsAt` out of `unifiedWindows`, falling back to the top-level field only when there is no entry (src/harnesses/pro…
- adversarial-planner-1d-plan-eval-cases: 1 nodes · 1 done
- adversarial-planner-2c-allowance-window-writers: 1 nodes · 1 done

## Recent user intents

None.

## Attempts and outcomes

- run adversarial-planner-1b-discovery-result-output: Run 1b: discovery-output-ingested, planning-contract-template and plan-verb done (plan-verb on attempt 2 after the field-ownership ratchet caught the pipeline writing open-question itself; the revision routes it through campaign note); promoted by hand (d6734b3). plan-eval-cases blocked with context_missing: src/cli/plan.mjs hardcodes the discovery runtime catalogue, so no eval case can point the pipeline at the replay harness. Superseded by contract 1d, which adds --runtimes <catalogue.json> to faberun plan and drives D23-D25 through the real CLI. USD 16.24 on the run. · claude-control-adversarial-planner · 2026-09-17T08:09:31.635Z
- run adversarial-planner-1d-plan-eval-cases: Run 1d (plan-eval-cases) done on the first attempt: faberun plan gained --runtimes <catalogue.json> so a caller declares the runtime catalogue the pipeline uses, and D23 (a frozen plan never launches), D24 (a contested plan emits no contract and names its findings) and D25 (a detached pipeline survives its launcher) pass on the replay harness with their discriminators. Promoted; the coordinator launched contract 2. USD 8.06. Phase 1 complete: the planning pipeline exists and its guarantees are proven by eval. · claude-control-adversarial-planner · 2026-09-17T12:05:13.333Z
- run adversarial-planner-2-evidence: Run 2 (evidence): both nodes exhausted, both for reasons the orchestrator had to resolve. seat-allowance-delta passed its deterministic items and the judge confirmed everything except one finding -- the sample reads the top-level utilization without pinning the rate-limit window, so a start/freeze pair can journal a meaningless cross-window delta; that finding is now the targeted fix contract 2b. planner-comparative-arm passed its own tests, --validate-planner-arm --min 8, --arm session and tsc twice, and exhausted twice on the brand ratchet reading the generated evals/planner/session-arm.json, a derived artefact carrying intent-factory-era campaign ids, in a file the node could not reach. The orchestrator landed both nodes' work on the campaign branch (3db8cdc, 55677e9) and made the generated report a derived artefact beside evals/golden (6f35280). USD 12.37 on the run. · claude-control-adversarial-planner · 2026-09-17T13:39:50.419Z
- run adversarial-planner-2c-allowance-window-writers: Run 2c (allowance-window-writers) done on the first attempt: one helper owns the seat.allowance event fields and both writers (campaign init's start sample, plan freeze's freeze sample) emit the window, so a same-window pair journals a real delta and a cross-window pair journals null with both windows visible. Promoted; the coordinator reported the campaign done. USD 1.54. · claude-control-adversarial-planner · 2026-09-17T14:34:14.199Z
- Campaign adversarial-planner, 2026-09-17 07:35 UTC to 14:45 UTC (7.2 h): fourth campaign of the improvement loop and the second half of the owner's planner proposal, Anthropic models only (claude-sonnet-5 workers USD 36.48, claude-opus-5 judge USD 7.59, USD 44.07 in all), six runs (1, 1b, 1d, 2, 2b, 2c) over 13 node instances, 15 attempts and 24 provider invocations, driven by supervise campaign from the installed 0.8.0 CLI. Landed on main by a --no-ff merge (8e8a1fc) with the full suite green. Delivered: a discovery result may carry a bounded structured `output` that survives every ingestion path (provider result, canonical file, resume, snapshot validation, judge prompt); src/plan/template.mjs builds the planner's one-node discovery contracts with the reviewer isolated to spec, facts and artefact; faberun plan runs draft, review and revise as successive runs, sizes and routes the plan with the operator's defaults winning, and freezes it with a digest, never launching the frozen contract, ending contested when a critical survives the round budget, with --runtimes declaring the catalogue; D23, D24 and D25 prove no-autostart, contested and detached on the replay harness with their discriminators; the seat samples the harness allowance, pins the rate-limit window it measured (rateLimitType read out of unifiedWindows) and journals the delta through one writer, nulling a cross-window pair; evals/planner compares the session arm with the planner arm over at least eight real campaign records with sample counts and null distinct from zero. What this campaign cost and why: five of the six runs were superseded contracts, every one for an orchestrator scope omission the workers caught precisely -- the ingestion paths of the result channel (1 -> 1b), the field-ownership writer of open-question (1b's plan-verb, fixed in revision), src/cli/plan.mjs's hardcoded runtime catalogue (1b -> 1d), the two seat.allowance call sites (2b -> 2c) -- plus one engine defect and one ratchet the nodes could not reach. The engine defect is … · claude-control-adversarial-planner · 2026-09-17T14:34:52.805Z

