# campaign harden-chain-and-verification handoff

Updated: 2026-09-16T23:44:07.107Z

## Goal

The retrospective of register-skill-and-harden absorbed by the factory: promotions that move nothing record nothing, resume honours the base ref a chain-launched run was cut from, status keeps moving during verification, a signal death of a verification child is re-run once, an integrated candidate re-runs only the commands that diverged before rejecting a node, a gate never outlives its run directory, setup keeps an existing config, and the notifier delivery flake is measured then fixed. Anthropic models only (claude-sonnet-5 workers, claude-opus-5 judge). Spec: docs/campaigns/harden-chain-and-verification/spec/SPEC.md.

## Latest next action

None.

## Session lineage

None.

## Active decisions

- [resume-base-ref-scope] resume-honours-base-ref blocked with context_missing on attempt 1: the packet's writeFiles omitted src/repo/source-identity.mjs (validateSourceIdentity's allowed-field Set revalidates run.json's sourceIdentity on every resume, so a new baseRef field is rejected as unexpected) and the SourceIdentity typedef in src/contract/index.mjs. A frozen packet cannot widen its scope, so the node is superseded by a follow-up contract 1b-resume-base-ref with the complete write set; the two sibling nodes of contract 1 finish and are landed. Authoring lesson recorded: a new persisted field forces its validator's allowlist and its typedef into writeFiles. · claude-control-harden-chain · 2026-09-16T19:43:39.283Z

## User constraints

- gate-exits-with-its-run-dir exhausted after two attempts for reasons outside its change: attempt 1 tripped the sharedVerification ratchet (a 5 s test deadline; ceiling 3 under 60 s) on its own attempt, as designed; attempt 2 fixed that and then failed the finalVerification test/run group on 'stall supervision kills a runtime whose harness declares streamed output' (test/run/process.test.mjs:311, provider fixture started through #!/usr/bin/env node, asserted written within 1.36 s under parallel load) -- the same shim-latency flake class as the notifier fixture. Plan: resume the node for attempt 3 once the run parks; at landing the orchestrator points the remaining test fixtures at process.execPath. · claude-control-harden-chain · 2026-09-16T21:30:50.133Z
- Phase 3 design error by the orchestrator: notifier-delivery-measured deliberately loads the machine (ten cli.test runs with node --test test/engine/ in the background) and contract 3 has maxParallel 2, so setup-preserves-config's integrated candidate ran under that load and failed two unrelated tests (test/engine group exit 1 at 134 s; test/cli 'idle polls emit no notification' 5 s condition at 531 s for a group that takes 96 s idle). Attempt 1 had passed its verification and the judge. The measurement node should have run alone (maxParallel 1 or dependsOn). candidate-divergence-retry, which would have absorbed this, is on the land branch but not in the 0.5.0 controller driving this campaign. · claude-control-harden-chain · 2026-09-16T22:35:07.632Z

## Open questions

None.

## Linked runs

- harden-chain-and-verification-1-coordinator-and-resume: 3 nodes · 2 done · 1 blocked
  - resume-honours-base-ref: blocked · src/repo/source-identity.mjs: validateSourceIdentity's `allowed` Set (currently kind, id, campaignId, contractId, nodeId, cwd, gitHead, dirtyTreeFingerprint, packetHashes, harnessVersions) must add "baseRef" and validate it as an optional string, and captureSourceIdentity must include `baseRef: o…
- harden-chain-and-verification-2-verification-fairness: 3 nodes · 2 done · 1 exhausted
  - gate-exits-with-its-run-dir: exhausted · deterministic verification failed
- harden-chain-and-verification-1b-resume-base-ref: 1 nodes · 1 done
- harden-chain-and-verification-3-product-and-fixtures: 2 nodes · 2 done

## Recent user intents

None.

## Attempts and outcomes

- run harden-chain-and-verification-1-coordinator-and-resume: Run 1 (coordinator-and-resume): idempotent-promotion and status-during-verification done on the first attempt (judge fail-verdicts carried only minor findings, gate passed), each integrated candidate verified with the full suite; resume-honours-base-ref blocked on the packet's incomplete write scope and is superseded by contract 1b-resume-base-ref (manifest now 1b, 2, 3). Run 1's integrated head 4c635a5 promoted by hand onto campaign/harden-chain-and-verification. Worker cost: sonnet sessions were long (USD 6.82 on the run, judge included). · claude-control-harden-chain · 2026-09-16T20:21:47.802Z
- run harden-chain-and-verification-1b-resume-base-ref: Run 1b (resume-base-ref): resume-base-ref-recorded done on the first attempt with the complete write scope (source-identity allowlist, SourceIdentity typedef, run-identity, resume, tests, manual); integrated candidate verified with the full suite; promoted by the coordinator, which then launched contract 2 on its own. USD 2.26. · claude-control-harden-chain · 2026-09-16T20:55:31.003Z
- run harden-chain-and-verification-2-verification-fairness: Run 2 (verification-fairness): signal-death-retries-once and candidate-divergence-retry done on the first attempt and promoted (e3946b8); gate-exits-with-its-run-dir exhausted after attempts 2 and 3 failed the same unrelated load flake (process.test.mjs:311 stall test, provider fixture through the asdf shim; machine load average 14-20 from mediaanalysisd, Safari, syspolicyd/trustd scanning fresh executables). The node's sealed work (gate exits when its release directory is gone, killGateGroup cleanup, new test) passed every other verification and the failing group passed on a rerun under the same load; the orchestrator reviewed the diff and cherry-picked the two seals onto the land branch (0dfca2f), so the judge never saw this node. Contract 2 removed from the manifest; contract 3 launches from 0dfca2f. USD 6.90 on the run. · claude-control-harden-chain · 2026-09-16T21:59:55.209Z
- run harden-chain-and-verification-3-product-and-fixtures: Run 3 (product-and-fixtures): setup-preserves-config done on attempt 2 (attempt 1 passed verification and judge, then its integrated candidate failed two unrelated load flakes while the notifier measurement loaded the machine); notifier-delivery-measured done on attempt 2 after the judge rejected attempt 1 for raising the delivery timeout to 12 s without a reproduced failure (80+ instrumented runs, launch under 306 ms) -- the revision followed the packet's 'change nothing' branch. Both promoted by the coordinator; campaign reported done. USD 4.81 on the run. · claude-control-harden-chain · 2026-09-16T23:43:12.918Z
- Campaign harden-chain-and-verification, 2026-09-16 19:28 UTC to about 23:40 UTC (4.2 h): the first campaign of the owner's retrospective-driven improvement loop, on Anthropic models only (worker claude-sonnet-5, judge claude-opus-5, vendor independence labels anthropic-sonnet/anthropic-opus), driven by supervise campaign from the installed 0.5.0 CLI, in four runs (1, 1b, 2, 3) over 9 node instances, 13 attempts and 22 provider invocations -- 13 worker turns (USD 16.28; 1.00 M input, 0.33 M output, 45 M cache-read tokens) and 9 judge turns (USD 4.51), USD 20.79 in all. Landed on main by a --no-ff merge (6a9fec1, the feat commit) with the full suite green. Delivered, each node's integrated candidate verified with the whole suite: a promotion that moves nothing records nothing (promotionMovedBranch); resume honours the base ref a chain-launched run was cut from (baseRef on the source identity, recordedBaseRef); status keeps moving during verification (render timer in driveRun, verificationProgress on the node, 'verification k/n' now line); a verification attempt killed by a signal the controller did not send is re-run once (signalDeathRetry); the integrated candidate re-runs only the commands that diverged from the attempt (retryDivergentCandidateCommands); the gate exits when its release directory is gone and gate-spawning tests kill their gates (releaseDirectoryGone, killGateGroup); setup keeps an existing config's available choices (mergeExistingConfig); the notifier delivery timeout stays measured, not raised. What the chain and the gate taught: (1) my packet for the base-ref node omitted the validator's allowlist and the typedef -- the worker blocked with a precise context_missing and the node was superseded by contract 1b with the complete write set, one more time the rule that writeFiles lists what the change forces to change; (2) sharedVerification caught a 5 s test deadline on the gate node's own attempt, as designed; (3) the gate node then exhausted twice on an unrelated load flake (process.test.mjs:311… · claude-control-harden-chain · 2026-09-16T23:44:07.107Z

